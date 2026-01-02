const logger = require('../../../src/utils/logger');
const winston = require('winston');

// Mock winston
jest.mock('winston', () => {
  const mockLogger = {
    error: jest.fn(),
    warn: jest.fn(),
    info: jest.fn(),
    http: jest.fn(),
    debug: jest.fn(),
    verbose: jest.fn(),
    silly: jest.fn()
  };

  return {
    createLogger: jest.fn().mockReturnValue(mockLogger),
    format: {
      combine: jest.fn(),
      timestamp: jest.fn(),
      printf: jest.fn(),
      colorize: jest.fn(),
      json: jest.fn(),
      simple: jest.fn()
    },
    transports: {
      Console: jest.fn(),
      File: jest.fn()
    }
  };
});

describe('Logger Utility', () => {
  let mockWinstonLogger;

  beforeEach(() => {
    mockWinstonLogger = winston.createLogger();
    jest.clearAllMocks();
  });

  describe('Log Levels', () => {
    test('should have all log methods', () => {
      expect(typeof logger.error).toBe('function');
      expect(typeof logger.warn).toBe('function');
      expect(typeof logger.info).toBe('function');
      expect(typeof logger.http).toBe('function');
      expect(typeof logger.debug).toBe('function');
      expect(typeof logger.verbose).toBe('function');
      expect(typeof logger.silly).toBe('function');
    });
  });

  describe('Log Methods', () => {
    test('should call error with message and meta', () => {
      const error = new Error('Test error');
      const meta = { userId: '123', requestId: 'abc' };

      logger.error('Error occurred', error, meta);

      expect(mockWinstonLogger.error).toHaveBeenCalledWith('Error occurred', {
        error,
        ...meta
      });
    });

    test('should call warn with message', () => {
      logger.warn('Warning message');
      expect(mockWinstonLogger.warn).toHaveBeenCalledWith('Warning message', {});
    });

    test('should call info with message and data', () => {
      const data = { action: 'login', userId: '123' };
      logger.info('User logged in', data);
      expect(mockWinstonLogger.info).toHaveBeenCalledWith('User logged in', data);
    });

    test('should call http with request info', () => {
      const reqInfo = {
        method: 'GET',
        url: '/api/test',
        status: 200,
        responseTime: '150ms'
      };

      logger.http('HTTP request', reqInfo);
      expect(mockWinstonLogger.http).toHaveBeenCalledWith('HTTP request', reqInfo);
    });

    test('should call debug with message', () => {
      logger.debug('Debug information');
      expect(mockWinstonLogger.debug).toHaveBeenCalledWith('Debug information', {});
    });
  });

  describe('Child Logger', () => {
    test('should create child logger with context', () => {
      const childLogger = logger.child({ module: 'auth', userId: '123' });
      
      expect(childLogger).toBeDefined();
      expect(typeof childLogger.info).toBe('function');
      
      childLogger.info('Child log');
      expect(mockWinstonLogger.info).toHaveBeenCalledWith('Child log', {
        module: 'auth',
        userId: '123'
      });
    });
  });

  describe('Request Logger', () => {
    test('should create request logger middleware', () => {
      const middleware = logger.requestLogger();
      
      expect(middleware).toBeDefined();
      expect(typeof middleware).toBe('function');
    });
  });

  describe('Error Logger', () => {
    test('should create error logger middleware', () => {
      const middleware = logger.errorLogger();
      
      expect(middleware).toBeDefined();
      expect(typeof middleware).toBe('function');
    });
  });

  describe('Stream', () => {
    test('should provide write stream for Morgan', () => {
      const stream = logger.stream;
      
      expect(stream).toBeDefined();
      expect(typeof stream.write).toBe('function');
      
      stream.write('GET /api/test 200 150ms');
      expect(mockWinstonLogger.http).toHaveBeenCalled();
    });
  });

  describe('Log Formatting', () => {
    test('should format log entry correctly', () => {
      const formatSpy = jest.spyOn(logger, 'formatLogEntry');
      const testData = { message: 'Test', level: 'info', timestamp: new Date() };
      
      const formatted = logger.formatLogEntry(testData);
      
      expect(formatSpy).toHaveBeenCalledWith(testData);
      expect(typeof formatted).toBe('string');
      expect(formatted).toContain('Test');
    });
  });

  describe('Configuration', () => {
    test('should get current log level', () => {
      const level = logger.getLevel();
      
      expect(level).toBeDefined();
      expect(['error', 'warn', 'info', 'http', 'verbose', 'debug', 'silly']).toContain(level);
    });

    test('should check if level is enabled', () => {
      expect(logger.isLevelEnabled('error')).toBe(true);
      expect(logger.isLevelEnabled('info')).toBe(true);
    });
  });

  describe('Performance Logging', () => {
    test('should log performance metrics', () => {
      const metrics = {
        operation: 'databaseQuery',
        duration: 150,
        query: 'SELECT * FROM users'
      };

      logger.performance('Database query performance', metrics);
      
      expect(mockWinstonLogger.info).toHaveBeenCalledWith(
        'Database query performance',
        expect.objectContaining({
          operation: 'databaseQuery',
          duration: 150,
          type: 'performance'
        })
      );
    });
  });

  describe('Audit Logging', () => {
    test('should log audit events', () => {
      const auditData = {
        action: 'USER_DELETE',
        userId: '123',
        targetId: '456',
        ip: '192.168.1.1'
      };

      logger.audit('User account deleted', auditData);
      
      expect(mockWinstonLogger.info).toHaveBeenCalledWith(
        'User account deleted',
        expect.objectContaining({
          action: 'USER_DELETE',
          type: 'audit'
        })
      );
    });
  });

  describe('Exception Handling', () => {
    test('should handle circular references in meta data', () => {
      const circularObj = {};
      circularObj.self = circularObj;

      logger.info('Test circular reference', circularObj);
      
      expect(mockWinstonLogger.info).toHaveBeenCalled();
    });

    test('should handle undefined/null messages', () => {
      logger.info(undefined);
      logger.info(null);
      
      expect(mockWinstonLogger.info).toHaveBeenCalledTimes(2);
    });
  });
});