const constants = require('../../../src/utils/constants');

describe('Constants Utility', () => {
  describe('HTTP Status Codes', () => {
    test('should have correct HTTP status codes', () => {
      expect(constants.HTTP_STATUS.OK).toBe(200);
      expect(constants.HTTP_STATUS.CREATED).toBe(201);
      expect(constants.HTTP_STATUS.BAD_REQUEST).toBe(400);
      expect(constants.HTTP_STATUS.UNAUTHORIZED).toBe(401);
      expect(constants.HTTP_STATUS.FORBIDDEN).toBe(403);
      expect(constants.HTTP_STATUS.NOT_FOUND).toBe(404);
      expect(constants.HTTP_STATUS.INTERNAL_SERVER_ERROR).toBe(500);
    });
  });

  describe('Error Codes', () => {
    test('should have defined error codes', () => {
      expect(constants.ERROR_CODES.VALIDATION_ERROR).toBeDefined();
      expect(constants.ERROR_CODES.AUTH_ERROR).toBeDefined();
      expect(constants.ERROR_CODES.DATABASE_ERROR).toBeDefined();
      expect(constants.ERROR_CODES.NETWORK_ERROR).toBeDefined();
      expect(constants.ERROR_CODES.UNKNOWN_ERROR).toBeDefined();
    });

    test('error codes should be strings', () => {
      Object.values(constants.ERROR_CODES).forEach(code => {
        expect(typeof code).toBe('string');
      });
    });
  });

  describe('Regex Patterns', () => {
    test('should have valid regex patterns', () => {
      expect(constants.REGEX.EMAIL.test('test@example.com')).toBe(true);
      expect(constants.REGEX.EMAIL.test('invalid')).toBe(false);

      expect(constants.REGEX.PHONE.test('+1234567890')).toBe(true);
      expect(constants.REGEX.PHONE.test('123')).toBe(false);

      expect(constants.REGEX.PASSWORD.test('StrongPass123!')).toBe(true);
      expect(constants.REGEX.PASSWORD.test('weak')).toBe(false);

      expect(constants.REGEX.UUID.test('123e4567-e89b-12d3-a456-426614174000')).toBe(true);
      expect(constants.REGEX.UUID.test('not-uuid')).toBe(false);

      expect(constants.REGEX.URL.test('https://example.com')).toBe(true);
      expect(constants.REGEX.URL.test('invalid')).toBe(false);
    });
  });

  describe('File Constants', () => {
    test('should have file size limits', () => {
      expect(constants.FILE.MAX_SIZE).toBeDefined();
      expect(typeof constants.FILE.MAX_SIZE).toBe('number');
      expect(constants.FILE.MAX_SIZE).toBeGreaterThan(0);
    });

    test('should have allowed file types', () => {
      expect(constants.FILE.ALLOWED_TYPES).toBeInstanceOf(Object);
      expect(constants.FILE.ALLOWED_TYPES.IMAGE).toBeInstanceOf(Array);
      expect(constants.FILE.ALLOWED_TYPES.DOCUMENT).toBeInstanceOf(Array);
      expect(constants.FILE.ALLOWED_TYPES.VIDEO).toBeInstanceOf(Array);
    });

    test('should have file upload paths', () => {
      expect(constants.FILE.UPLOAD_PATH).toBeDefined();
      expect(typeof constants.FILE.UPLOAD_PATH).toBe('string');
    });
  });

  describe('Date/Time Formats', () => {
    test('should have date formats', () => {
      expect(constants.DATE_FORMAT.SHORT).toBeDefined();
      expect(constants.DATE_FORMAT.LONG).toBeDefined();
      expect(constants.DATE_FORMAT.ISO).toBe('YYYY-MM-DDTHH:mm:ss.SSSZ');
    });

    test('should have time constants', () => {
      expect(constants.TIME.ONE_HOUR_MS).toBe(3600000);
      expect(constants.TIME.ONE_DAY_MS).toBe(86400000);
      expect(constants.TIME.ONE_WEEK_MS).toBe(604800000);
    });
  });

  describe('Security Constants', () => {
    test('should have security settings', () => {
      expect(constants.SECURITY.PASSWORD_SALT_ROUNDS).toBeDefined();
      expect(constants.SECURITY.PASSWORD_SALT_ROUNDS).toBeGreaterThan(0);

      expect(constants.SECURITY.JWT_SECRET).toBeDefined();
      expect(typeof constants.SECURITY.JWT_SECRET).toBe('string');

      expect(constants.SECURITY.BCRYPT_ROUNDS).toBeDefined();
      expect(constants.SECURITY.BCRYPT_ROUNDS).toBeGreaterThan(0);
    });
  });

  describe('Database Constants', () => {
    test('should have database settings', () => {
      expect(constants.DATABASE.CONNECTION_LIMIT).toBeDefined();
      expect(constants.DATABASE.CONNECTION_LIMIT).toBeGreaterThan(0);

      expect(constants.DATABASE.QUERY_TIMEOUT).toBeDefined();
      expect(constants.DATABASE.QUERY_TIMEOUT).toBeGreaterThan(0);
    });
  });

  describe('API Constants', () => {
    test('should have API settings', () => {
      expect(constants.API.RATE_LIMIT_WINDOW_MS).toBeDefined();
      expect(constants.API.RATE_LIMIT_WINDOW_MS).toBeGreaterThan(0);

      expect(constants.API.RATE_LIMIT_MAX_REQUESTS).toBeDefined();
      expect(constants.API.RATE_LIMIT_MAX_REQUESTS).toBeGreaterThan(0);

      expect(constants.API.DEFAULT_PAGE_SIZE).toBeDefined();
      expect(constants.API.DEFAULT_PAGE_SIZE).toBeGreaterThan(0);

      expect(constants.API.MAX_PAGE_SIZE).toBeDefined();
      expect(constants.API.MAX_PAGE_SIZE).toBeGreaterThan(constants.API.DEFAULT_PAGE_SIZE);
    });
  });

  describe('Cache Constants', () => {
    test('should have cache settings', () => {
      expect(constants.CACHE.DEFAULT_TTL).toBeDefined();
      expect(constants.CACHE.DEFAULT_TTL).toBeGreaterThan(0);

      expect(constants.CACHE.PREFIX).toBeDefined();
      expect(typeof constants.CACHE.PREFIX).toBe('string');
    });
  });

  describe('Validation Constants', () => {
    test('should have validation limits', () => {
      expect(constants.VALIDATION.MAX_STRING_LENGTH).toBeDefined();
      expect(constants.VALIDATION.MAX_STRING_LENGTH).toBeGreaterThan(0);

      expect(constants.VALIDATION.MIN_PASSWORD_LENGTH).toBeDefined();
      expect(constants.VALIDATION.MIN_PASSWORD_LENGTH).toBeGreaterThan(0);

      expect(constants.VALIDATION.MAX_PASSWORD_LENGTH).toBeDefined();
      expect(constants.VALIDATION.MAX_PASSWORD_LENGTH).toBeGreaterThan(
        constants.VALIDATION.MIN_PASSWORD_LENGTH
      );
    });
  });

  describe('Environment Constants', () => {
    test('should have environment values', () => {
      expect(constants.ENV.PRODUCTION).toBe('production');
      expect(constants.ENV.DEVELOPMENT).toBe('development');
      expect(constants.ENV.TEST).toBe('test');
    });
  });

  describe('Export Verification', () => {
    test('should export all required constant groups', () => {
      const expectedGroups = [
        'HTTP_STATUS',
        'ERROR_CODES',
        'REGEX',
        'FILE',
        'DATE_FORMAT',
        'TIME',
        'SECURITY',
        'DATABASE',
        'API',
        'CACHE',
        'VALIDATION',
        'ENV'
      ];

      expectedGroups.forEach(group => {
        expect(constants[group]).toBeDefined();
        expect(typeof constants[group]).toBe('object');
      });
    });

    test('constants should be frozen (immutable)', () => {
      expect(Object.isFrozen(constants)).toBe(true);
      expect(Object.isFrozen(constants.HTTP_STATUS)).toBe(true);
      expect(Object.isFrozen(constants.ERROR_CODES)).toBe(true);
    });
  });
});