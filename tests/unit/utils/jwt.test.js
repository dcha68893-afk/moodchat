const jwt = require('../../../src/utils/jwt');
const config = require('../../../src/config');

// Mock config
jest.mock('../../../src/config', () => ({
  jwt: {
    secret: 'test-secret-key',
    expiresIn: '1h',
    refreshExpiresIn: '7d'
  }
}));

describe('JWT Utility', () => {
  const testPayload = { userId: '123', email: 'test@example.com' };
  let generatedToken;
  let generatedRefreshToken;

  describe('generateToken', () => {
    test('should generate valid JWT token', () => {
      generatedToken = jwt.generateToken(testPayload);
      
      expect(generatedToken).toBeDefined();
      expect(typeof generatedToken).toBe('string');
      expect(generatedToken.split('.')).toHaveLength(3);
    });

    test('should throw error for invalid payload', () => {
      expect(() => jwt.generateToken(null)).toThrow();
      expect(() => jwt.generateToken({})).toThrow();
    });
  });

  describe('generateRefreshToken', () => {
    test('should generate refresh token', () => {
      generatedRefreshToken = jwt.generateRefreshToken(testPayload);
      
      expect(generatedRefreshToken).toBeDefined();
      expect(typeof generatedRefreshToken).toBe('string');
    });
  });

  describe('verifyToken', () => {
    test('should verify valid token', () => {
      const decoded = jwt.verifyToken(generatedToken);
      
      expect(decoded).toHaveProperty('userId', testPayload.userId);
      expect(decoded).toHaveProperty('email', testPayload.email);
      expect(decoded).toHaveProperty('exp');
      expect(decoded).toHaveProperty('iat');
    });

    test('should throw error for invalid token', () => {
      expect(() => jwt.verifyToken('invalid.token.here')).toThrow();
      expect(() => jwt.verifyToken('')).toThrow();
    });

    test('should throw error for expired token', () => {
      const expiredToken = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJ1c2VySWQiOiIxMjMiLCJleHAiOjE2MDAwMDAwMDB9.invalid-signature';
      expect(() => jwt.verifyToken(expiredToken)).toThrow();
    });
  });

  describe('decodeToken', () => {
    test('should decode token without verification', () => {
      const decoded = jwt.decodeToken(generatedToken);
      
      expect(decoded).toHaveProperty('userId', testPayload.userId);
      expect(decoded).toHaveProperty('email', testPayload.email);
    });

    test('should return null for invalid token', () => {
      expect(jwt.decodeToken('invalid')).toBeNull();
    });
  });

  describe('refreshToken', () => {
    test('should refresh valid token', () => {
      const newToken = jwt.refreshToken(generatedRefreshToken);
      
      expect(newToken).toBeDefined();
      expect(typeof newToken).toBe('string');
    });

    test('should throw error for invalid refresh token', () => {
      expect(() => jwt.refreshToken('invalid-token')).toThrow();
    });
  });

  describe('isTokenExpired', () => {
    test('should check token expiration', () => {
      const expiredToken = jwt.generateToken(testPayload, '-1h');
      const validToken = jwt.generateToken(testPayload);
      
      expect(jwt.isTokenExpired(expiredToken)).toBe(true);
      expect(jwt.isTokenExpired(validToken)).toBe(false);
    });
  });

  describe('getTokenFromHeader', () => {
    test('should extract token from Authorization header', () => {
      const header = 'Bearer ' + generatedToken;
      expect(jwt.getTokenFromHeader(header)).toBe(generatedToken);
    });

    test('should return null for invalid header', () => {
      expect(jwt.getTokenFromHeader('')).toBeNull();
      expect(jwt.getTokenFromHeader('Basic credentials')).toBeNull();
      expect(jwt.getTokenFromHeader(null)).toBeNull();
    });
  });

  describe('validateTokenStructure', () => {
    test('should validate token structure', () => {
      expect(jwt.validateTokenStructure(generatedToken)).toBe(true);
      expect(jwt.validateTokenStructure('invalid')).toBe(false);
      expect(jwt.validateTokenStructure('a.b')).toBe(false);
      expect(jwt.validateTokenStructure('')).toBe(false);
    });
  });
});