const {
  isValidEmail,
  isValidPhone,
  isValidPassword,
  isValidUUID,
  validateRequiredFields,
  isValidDate,
  isValidURL,
  isValidJSON,
  sanitizeInput
} = require('../../../src/utils/validators');

describe('Validators Utility', () => {
  describe('isValidEmail', () => {
    test('should return true for valid emails', () => {
      expect(isValidEmail('test@example.com')).toBe(true);
      expect(isValidEmail('user.name+tag@domain.co.uk')).toBe(true);
      expect(isValidEmail('user_name@sub.domain.com')).toBe(true);
    });

    test('should return false for invalid emails', () => {
      expect(isValidEmail('invalid-email')).toBe(false);
      expect(isValidEmail('@domain.com')).toBe(false);
      expect(isValidEmail('test@.com')).toBe(false);
      expect(isValidEmail('')).toBe(false);
      expect(isValidEmail(null)).toBe(false);
      expect(isValidEmail(undefined)).toBe(false);
    });
  });

  describe('isValidPhone', () => {
    test('should validate phone numbers correctly', () => {
      expect(isValidPhone('+12345678901')).toBe(true);
      expect(isValidPhone('(123) 456-7890')).toBe(true);
      expect(isValidPhone('123-456-7890')).toBe(true);
    });

    test('should reject invalid phone numbers', () => {
      expect(isValidPhone('123')).toBe(false);
      expect(isValidPhone('abc-def-ghij')).toBe(false);
      expect(isValidPhone('')).toBe(false);
    });
  });

  describe('isValidPassword', () => {
    test('should validate strong passwords', () => {
      expect(isValidPassword('StrongPass123!')).toBe(true);
      expect(isValidPassword('Aa1@' + 'x'.repeat(8))).toBe(true);
    });

    test('should reject weak passwords', () => {
      expect(isValidPassword('weak')).toBe(false);
      expect(isValidPassword('nouppercase123!')).toBe(false);
      expect(isValidPassword('NOLOWERCASE123!')).toBe(false);
      expect(isValidPassword('NoSpecial123')).toBe(false);
      expect(isValidPassword('NoNumber!@#')).toBe(false);
      expect(isValidPassword('Sh0rt!')).toBe(false);
    });
  });

  describe('isValidUUID', () => {
    test('should validate UUID v4', () => {
      const validUUID = '123e4567-e89b-12d3-a456-426614174000';
      expect(isValidUUID(validUUID)).toBe(true);
    });

    test('should reject invalid UUIDs', () => {
      expect(isValidUUID('not-a-uuid')).toBe(false);
      expect(isValidUUID('123e4567-e89b-12d3-a456')).toBe(false);
      expect(isValidUUID('')).toBe(false);
    });
  });

  describe('validateRequiredFields', () => {
    test('should return empty array for valid data', () => {
      const data = { name: 'John', email: 'test@example.com', age: 30 };
      const required = ['name', 'email'];
      expect(validateRequiredFields(data, required)).toEqual([]);
    });

    test('should return missing fields', () => {
      const data = { name: 'John' };
      const required = ['name', 'email', 'age'];
      expect(validateRequiredFields(data, required)).toEqual(['email', 'age']);
    });

    test('should handle empty or null data', () => {
      expect(validateRequiredFields(null, ['name'])).toEqual(['name']);
      expect(validateRequiredFields({}, ['name'])).toEqual(['name']);
    });
  });

  describe('isValidDate', () => {
    test('should validate dates correctly', () => {
      expect(isValidDate('2023-12-25')).toBe(true);
      expect(isValidDate('2023-12-25T10:30:00Z')).toBe(true);
    });

    test('should reject invalid dates', () => {
      expect(isValidDate('invalid-date')).toBe(false);
      expect(isValidDate('2023-13-45')).toBe(false);
    });
  });

  describe('isValidURL', () => {
    test('should validate URLs', () => {
      expect(isValidURL('https://example.com')).toBe(true);
      expect(isValidURL('http://localhost:3000')).toBe(true);
      expect(isValidURL('ftp://files.example.com')).toBe(true);
    });

    test('should reject invalid URLs', () => {
      expect(isValidURL('not-a-url')).toBe(false);
      expect(isValidURL('http://')).toBe(false);
    });
  });

  describe('isValidJSON', () => {
    test('should validate JSON strings', () => {
      expect(isValidJSON('{"name": "John"}')).toBe(true);
      expect(isValidJSON('[1, 2, 3]')).toBe(true);
    });

    test('should reject invalid JSON', () => {
      expect(isValidJSON('{name: John}')).toBe(false);
      expect(isValidJSON('not json')).toBe(false);
    });
  });

  describe('sanitizeInput', () => {
    test('should sanitize input strings', () => {
      expect(sanitizeInput('<script>alert("xss")</script>')).not.toContain('<script>');
      expect(sanitizeInput('  trim me  ')).toBe('trim me');
      expect(sanitizeInput('normal text')).toBe('normal text');
    });

    test('should handle non-string inputs', () => {
      expect(sanitizeInput(123)).toBe('123');
      expect(sanitizeInput(null)).toBe('');
      expect(sanitizeInput(undefined)).toBe('');
    });
  });
});