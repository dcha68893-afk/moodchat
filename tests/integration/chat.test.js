/**
 * @fileoverview Authentication integration tests
 * @module tests/integration/auth.test.js
 */

const request = require('supertest');
const mongoose = require('mongoose');
const jwt = require('jsonwebtoken');
const app = require('../../src/app');
const User = require('../../src/models/User');
const RefreshToken = require('../../src/models/RefreshToken');
const { connectDB, disconnectDB, clearDB } = require('../utils/testDB');

// Test constants
const TEST_PORT = process.env.TEST_PORT || 5001;
const API_PREFIX = process.env.API_PREFIX || '/api/v1';

describe('Authentication Integration Tests', () => {
  let server;
  let testUser;
  let accessToken;
  let refreshToken;

  // Test data
  const validUserData = {
    email: 'test@example.com',
    password: 'SecurePass123!',
    firstName: 'John',
    lastName: 'Doe',
    username: 'johndoe123'
  };

  const invalidUserData = {
    email: 'invalid-email',
    password: '123', // Too short
    firstName: 'J', // Too short
    lastName: 'D'
  };

  const loginCredentials = {
    email: 'test@example.com',
    password: 'SecurePass123!'
  };

  const wrongCredentials = {
    email: 'test@example.com',
    password: 'WrongPass456!'
  };

  /**
   * Setup before all tests
   */
  beforeAll(async () => {
    // Connect to test database
    await connectDB();
    
    // Start test server
    server = app.listen(TEST_PORT, () => {
      console.log(`Test server running on port ${TEST_PORT}`);
    });
  });

  /**
   * Cleanup after all tests
   */
  afterAll(async () => {
    // Close server
    await new Promise((resolve) => server.close(resolve));
    
    // Disconnect from database
    await disconnectDB();
  });

  /**
   * Setup before each test
   */
  beforeEach(async () => {
    await clearDB();
    accessToken = null;
    refreshToken = null;
    testUser = null;
  });

  /**
   * Helper function to register a user
   */
  const registerUser = async (userData = validUserData) => {
    return request(app)
      .post(`${API_PREFIX}/auth/register`)
      .send(userData);
  };

  /**
   * Helper function to login user
   */
  const loginUser = async (credentials = loginCredentials) => {
    return request(app)
      .post(`${API_PREFIX}/auth/login`)
      .send(credentials);
  };

  /**
   * Helper function to logout user
   */
  const logoutUser = async (token) => {
    return request(app)
      .post(`${API_PREFIX}/auth/logout`)
      .set('Authorization', `Bearer ${token}`);
  };

  /**
   * Helper function to refresh token
   */
  const refreshTokenRequest = async (refreshTokenValue) => {
    return request(app)
      .post(`${API_PREFIX}/auth/refresh-token`)
      .send({ refreshToken: refreshTokenValue });
  };

  /**
   * Helper function to validate JWT structure
   */
  const validateJWT = (token) => {
    expect(token).toBeDefined();
    expect(typeof token).toBe('string');
    expect(token.split('.').length).toBe(3); // Header.payload.signature
  };

  /**
   * Helper function to validate user in response
   */
  const validateUserResponse = (userResponse, expectedData = validUserData) => {
    expect(userResponse).toHaveProperty('id');
    expect(userResponse).toHaveProperty('email', expectedData.email);
    expect(userResponse).toHaveProperty('firstName', expectedData.firstName);
    expect(userResponse).toHaveProperty('lastName', expectedData.lastName);
    expect(userResponse).toHaveProperty('username', expectedData.username);
    expect(userResponse).toHaveProperty('isActive', true);
    expect(userResponse).toHaveProperty('createdAt');
    expect(userResponse).toHaveProperty('updatedAt');
    expect(userResponse).not.toHaveProperty('password');
    expect(userResponse).not.toHaveProperty('refreshTokens');
  };

  /**
   * Test Suite: User Registration
   */
  describe('POST /auth/register', () => {
    test('should register a new user with valid data', async () => {
      const response = await registerUser();

      expect(response.status).toBe(201);
      expect(response.body).toHaveProperty('success', true);
      expect(response.body).toHaveProperty('message', 'User registered successfully');
      
      // Validate tokens
      expect(response.body).toHaveProperty('tokens');
      expect(response.body.tokens).toHaveProperty('access');
      expect(response.body.tokens).toHaveProperty('refresh');
      
      // Validate JWT structure
      validateJWT(response.body.tokens.access);
      validateJWT(response.body.tokens.refresh);
      
      // Validate user data
      validateUserResponse(response.body.user);

      // Verify user exists in database
      const userInDb = await User.findOne({ email: validUserData.email });
      expect(userInDb).toBeDefined();
      expect(userInDb.email).toBe(validUserData.email);
      expect(userInDb.isEmailVerified).toBe(false);
      expect(userInDb.isActive).toBe(true);
      
      // Verify refresh token exists in database
      const refreshTokenInDb = await RefreshToken.findOne({
        userId: userInDb._id,
        token: response.body.tokens.refresh
      });
      expect(refreshTokenInDb).toBeDefined();
      expect(refreshTokenInDb.isRevoked).toBe(false);
    });

    test('should return 400 for duplicate email registration', async () => {
      // First registration
      await registerUser();
      
      // Second registration with same email
      const duplicateUser = { ...validUserData, username: 'differentuser' };
      const response = await registerUser(duplicateUser);

      expect(response.status).toBe(400);
      expect(response.body).toHaveProperty('success', false);
      expect(response.body).toHaveProperty('error', 'Email already registered');
    });

    test('should return 400 for duplicate username registration', async () => {
      // First registration
      await registerUser();
      
      // Second registration with same username
      const duplicateUser = { 
        ...validUserData, 
        email: 'different@example.com',
        username: validUserData.username
      };
      const response = await registerUser(duplicateUser);

      expect(response.status).toBe(400);
      expect(response.body).toHaveProperty('success', false);
      expect(response.body).toHaveProperty('error', 'Username already taken');
    });

    test('should return 400 for invalid user data', async () => {
      const response = await registerUser(invalidUserData);

      expect(response.status).toBe(400);
      expect(response.body).toHaveProperty('success', false);
      expect(response.body).toHaveProperty('errors');
      expect(Array.isArray(response.body.errors)).toBe(true);
      
      // Check for specific validation errors
      const errors = response.body.errors;
      expect(errors.some(e => e.msg.includes('email'))).toBe(true);
      expect(errors.some(e => e.msg.includes('password'))).toBe(true);
      expect(errors.some(e => e.msg.includes('firstName'))).toBe(true);
    });

    test('should return 400 for missing required fields', async () => {
      const response = await request(app)
        .post(`${API_PREFIX}/auth/register`)
        .send({ email: 'test@example.com' }); // Missing other fields

      expect(response.status).toBe(400);
      expect(response.body).toHaveProperty('success', false);
      expect(response.body).toHaveProperty('errors');
    });

    test('should sanitize input and prevent XSS attacks', async () => {
      const maliciousUserData = {
        ...validUserData,
        email: 'test@example.com',
        firstName: '<script>alert("xss")</script>John',
        lastName: 'Doe<script>evil()</script>'
      };

      const response = await registerUser(maliciousUserData);

      expect(response.status).toBe(201);
      expect(response.body.user.firstName).not.toContain('<script>');
      expect(response.body.user.lastName).not.toContain('<script>');
      expect(response.body.user.firstName).toBe('John'); // Sanitized
    });
  });

  /**
   * Test Suite: User Login
   */
  describe('POST /auth/login', () => {
    beforeEach(async () => {
      // Register a user before each login test
      await registerUser();
    });

    test('should login user with valid credentials', async () => {
      const response = await loginUser();

      expect(response.status).toBe(200);
      expect(response.body).toHaveProperty('success', true);
      expect(response.body).toHaveProperty('message', 'Login successful');
      
      // Validate tokens
      expect(response.body).toHaveProperty('tokens');
      expect(response.body.tokens).toHaveProperty('access');
      expect(response.body.tokens).toHaveProperty('refresh');
      
      // Validate JWT structure
      validateJWT(response.body.tokens.access);
      validateJWT(response.body.tokens.refresh);
      
      // Validate user data
      validateUserResponse(response.body.user);

      // Store tokens for later tests
      accessToken = response.body.tokens.access;
      refreshToken = response.body.tokens.refresh;
    });

    test('should return 401 for incorrect password', async () => {
      const response = await request(app)
        .post(`${API_PREFIX}/auth/login`)
        .send(wrongCredentials);

      expect(response.status).toBe(401);
      expect(response.body).toHaveProperty('success', false);
      expect(response.body).toHaveProperty('error', 'Invalid credentials');
    });

    test('should return 404 for non-existent user', async () => {
      const response = await request(app)
        .post(`${API_PREFIX}/auth/login`)
        .send({
          email: 'nonexistent@example.com',
          password: 'SomePass123!'
        });

      expect(response.status).toBe(404);
      expect(response.body).toHaveProperty('success', false);
      expect(response.body).toHaveProperty('error', 'User not found');
    });

    test('should return 401 for inactive user', async () => {
      // Deactivate the user
      await User.findOneAndUpdate(
        { email: validUserData.email },
        { isActive: false }
      );

      const response = await loginUser();

      expect(response.status).toBe(401);
      expect(response.body).toHaveProperty('success', false);
      expect(response.body).toHaveProperty('error', 'Account is deactivated');
    });

    test('should return 400 for missing credentials', async () => {
      const response = await request(app)
        .post(`${API_PREFIX}/auth/login`)
        .send({ email: validUserData.email }); // Missing password

      expect(response.status).toBe(400);
      expect(response.body).toHaveProperty('success', false);
      expect(response.body).toHaveProperty('error');
    });

    test('should track login activity and IP address', async () => {
      const response = await loginUser();
      
      const user = await User.findOne({ email: validUserData.email });
      expect(user.lastLoginAt).toBeDefined();
      expect(user.lastLoginIp).toBeDefined();
    });
  });

  /**
   * Test Suite: Token Refresh
   */
  describe('POST /auth/refresh-token', () => {
    beforeEach(async () => {
      // Register and login to get tokens
      const registerResponse = await registerUser();
      refreshToken = registerResponse.body.tokens.refresh;
    });

    test('should refresh access token with valid refresh token', async () => {
      const response = await refreshTokenRequest(refreshToken);

      expect(response.status).toBe(200);
      expect(response.body).toHaveProperty('success', true);
      expect(response.body).toHaveProperty('accessToken');
      expect(response.body).toHaveProperty('refreshToken');
      
      // Validate new tokens
      validateJWT(response.body.accessToken);
      validateJWT(response.body.refreshToken);
      
      // New refresh token should be different
      expect(response.body.refreshToken).not.toBe(refreshToken);

      // Old refresh token should be revoked
      const oldToken = await RefreshToken.findOne({ token: refreshToken });
      expect(oldToken.isRevoked).toBe(true);

      // New refresh token should be valid
      const newToken = await RefreshToken.findOne({ 
        token: response.body.refreshToken 
      });
      expect(newToken).toBeDefined();
      expect(newToken.isRevoked).toBe(false);
    });

    test('should return 401 for invalid refresh token', async () => {
      const response = await refreshTokenRequest('invalid-refresh-token');

      expect(response.status).toBe(401);
      expect(response.body).toHaveProperty('success', false);
      expect(response.body).toHaveProperty('error', 'Invalid refresh token');
    });

    test('should return 401 for revoked refresh token', async () => {
      // Revoke the token
      await RefreshToken.findOneAndUpdate(
        { token: refreshToken },
        { isRevoked: true }
      );

      const response = await refreshTokenRequest(refreshToken);

      expect(response.status).toBe(401);
      expect(response.body).toHaveProperty('success', false);
      expect(response.body).toHaveProperty('error', 'Refresh token revoked');
    });

    test('should return 401 for expired refresh token', async () => {
      // Create an expired token manually
      const user = await User.findOne({ email: validUserData.email });
      const expiredToken = jwt.sign(
        { userId: user._id, type: 'refresh' },
        process.env.JWT_REFRESH_SECRET,
        { expiresIn: '-1h' } // Already expired
      );

      // Save expired token
      await RefreshToken.create({
        userId: user._id,
        token: expiredToken,
        expiresAt: new Date(Date.now() - 3600000), // 1 hour ago
        userAgent: 'test',
        ipAddress: '127.0.0.1'
      });

      const response = await refreshTokenRequest(expiredToken);

      expect(response.status).toBe(401);
      expect(response.body).toHaveProperty('success', false);
      expect(response.body).toHaveProperty('error', 'Refresh token expired');
    });

    test('should return 400 for missing refresh token', async () => {
      const response = await request(app)
        .post(`${API_PREFIX}/auth/refresh-token`)
        .send({}); // Empty body

      expect(response.status).toBe(400);
      expect(response.body).toHaveProperty('success', false);
      expect(response.body).toHaveProperty('error', 'Refresh token is required');
    });
  });

  /**
   * Test Suite: User Logout
   */
  describe('POST /auth/logout', () => {
    beforeEach(async () => {
      // Register, login and get tokens
      const registerResponse = await registerUser();
      const loginResponse = await loginUser();
      accessToken = loginResponse.body.tokens.access;
      refreshToken = loginResponse.body.tokens.refresh;
    });

    test('should logout user and revoke refresh token', async () => {
      const response = await logoutUser(accessToken);

      expect(response.status).toBe(200);
      expect(response.body).toHaveProperty('success', true);
      expect(response.body).toHaveProperty('message', 'Logout successful');

      // Verify refresh token is revoked
      const revokedToken = await RefreshToken.findOne({ token: refreshToken });
      expect(revokedToken.isRevoked).toBe(true);
    });

    test('should return 401 for logout without token', async () => {
      const response = await request(app)
        .post(`${API_PREFIX}/auth/logout`)
        .send({});

      expect(response.status).toBe(401);
      expect(response.body).toHaveProperty('success', false);
      expect(response.body).toHaveProperty('error', 'No token provided');
    });

    test('should return 401 for logout with invalid token', async () => {
      const response = await request(app)
        .post(`${API_PREFIX}/auth/logout`)
        .set('Authorization', 'Bearer invalid-token')
        .send({});

      expect(response.status).toBe(401);
      expect(response.body).toHaveProperty('success', false);
      expect(response.body).toHaveProperty('error', 'Invalid token');
    });

    test('should handle logout all sessions', async () => {
      // Create multiple sessions
      const loginResponse2 = await loginUser();
      const refreshToken2 = loginResponse2.body.tokens.refresh;

      // Logout all sessions
      const response = await request(app)
        .post(`${API_PREFIX}/auth/logout-all`)
        .set('Authorization', `Bearer ${accessToken}`)
        .send({});

      expect(response.status).toBe(200);
      expect(response.body).toHaveProperty('success', true);
      expect(response.body).toHaveProperty('message', 'Logged out from all devices');

      // Verify all refresh tokens are revoked
      const tokens = await RefreshToken.find({ 
        userId: (await User.findOne({ email: validUserData.email }))._id 
      });
      
      tokens.forEach(token => {
        expect(token.isRevoked).toBe(true);
      });
    });
  });

  /**
   * Test Suite: Complete Authentication Flow
   */
  describe('Complete Authentication Flow', () => {
    test('should complete full auth cycle: register → login → refresh → logout', async () => {
      // 1. Register
      const registerResponse = await registerUser();
      expect(registerResponse.status).toBe(201);
      const initialRefreshToken = registerResponse.body.tokens.refresh;

      // 2. Login (new session)
      const loginResponse = await loginUser();
      expect(loginResponse.status).toBe(200);
      accessToken = loginResponse.body.tokens.access;
      refreshToken = loginResponse.body.tokens.refresh;

      // 3. Use protected endpoint
      const protectedResponse = await request(app)
        .get(`${API_PREFIX}/auth/me`)
        .set('Authorization', `Bearer ${accessToken}`);

      expect(protectedResponse.status).toBe(200);
      expect(protectedResponse.body.user.email).toBe(validUserData.email);

      // 4. Refresh token
      const refreshResponse = await refreshTokenRequest(refreshToken);
      expect(refreshResponse.status).toBe(200);
      const newAccessToken = refreshResponse.body.accessToken;
      const newRefreshToken = refreshResponse.body.refreshToken;

      // 5. Use new token on protected endpoint
      const protectedResponse2 = await request(app)
        .get(`${API_PREFIX}/auth/me`)
        .set('Authorization', `Bearer ${newAccessToken}`);

      expect(protectedResponse2.status).toBe(200);

      // 6. Logout
      const logoutResponse = await request(app)
        .post(`${API_PREFIX}/auth/logout`)
        .set('Authorization', `Bearer ${newAccessToken}`);

      expect(logoutResponse.status).toBe(200);

      // 7. Verify old tokens no longer work
      const failedRefresh = await refreshTokenRequest(newRefreshToken);
      expect(failedRefresh.status).toBe(401);

      // Verify all tokens are revoked
      const user = await User.findOne({ email: validUserData.email });
      const tokens = await RefreshToken.find({ userId: user._id });
      
      tokens.forEach(token => {
        expect(token.isRevoked).toBe(true);
      });
    });
  });

  /**
   * Test Suite: Security Tests
   */
  describe('Security Tests', () => {
    test('should prevent brute force attacks with rate limiting', async () => {
      const attempts = 10;
      let lastStatus = 200;

      // Make multiple failed login attempts
      for (let i = 0; i < attempts; i++) {
        const response = await request(app)
          .post(`${API_PREFIX}/auth/login`)
          .send({
            email: validUserData.email,
            password: 'WrongPassword' + i
          });
        
        lastStatus = response.status;
        
        if (response.status === 429) {
          break;
        }
      }

      // Should eventually get rate limited
      expect(lastStatus).toBe(429);
    });

    test('should include security headers', async () => {
      const response = await request(app)
        .post(`${API_PREFIX}/auth/login`)
        .send(loginCredentials);

      expect(response.headers).toHaveProperty('x-content-type-options', 'nosniff');
      expect(response.headers).toHaveProperty('x-frame-options');
      expect(response.headers).toHaveProperty('x-xss-protection');
    });

    test('should not expose sensitive information in errors', async () => {
      const response = await request(app)
        .post(`${API_PREFIX}/auth/login`)
        .send({
          email: 'nonexistent@example.com',
          password: 'SecretPass123!'
        });

      // Error messages should not reveal whether user exists
      expect(response.body.error).not.toMatch(/user (not found|exists)/i);
      expect(response.body.error).toBe('Invalid credentials');
    });
  });

  /**
   * Test Suite: Edge Cases
   */
  describe('Edge Cases', () => {
    test('should handle very long input gracefully', async () => {
      const longString = 'a'.repeat(1000);
      const userData = {
        ...validUserData,
        email: 'longtest@example.com',
        firstName: longString
      };

      const response = await registerUser(userData);

      // Should either reject with 400 or sanitize/shorten
      expect([201, 400]).toContain(response.status);
      
      if (response.status === 201) {
        expect(response.body.user.firstName.length).toBeLessThan(256);
      }
    });

    test('should handle special characters in input', async () => {
      const userData = {
        ...validUserData,
        email: 'special-chars@example.com',
        firstName: "John O'Connor",
        lastName: 'Doe-Smith Jr.',
        username: 'user_name-123'
      };

      const response = await registerUser(userData);

      expect(response.status).toBe(201);
      expect(response.body.user.firstName).toBe("John O'Connor");
      expect(response.body.user.lastName).toBe('Doe-Smith Jr.');
    });

    test('should handle concurrent requests', async () => {
      const requests = Array(5).fill().map(() => 
        registerUser({
          ...validUserData,
          email: `user${Math.random()}@example.com`,
          username: `user${Math.random()}`
        })
      );

      const responses = await Promise.all(requests);
      
      // All should succeed or properly handle conflicts
      responses.forEach(response => {
        expect([201, 400]).toContain(response.status);
      });
    });
  });
});