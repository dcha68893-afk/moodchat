﻿﻿// src/server.js - UPDATED VERSION WITH IMPROVED STABILITY
require('dotenv').config();
const express = require('express');
const cors = require('cors');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const helmet = require('helmet');

const app = express();

// ========== CONFIGURATION ==========
const PORT = process.env.PORT || 4000;
const NODE_ENV = process.env.NODE_ENV || 'development';
const JWT_SECRET = process.env.JWT_ACCESS_SECRET || process.env.JWT_SECRET || 'development-secret-key-change-in-production';

// ========== IMPROVED CORS CONFIGURATION ==========
const corsOptions = {
  origin: function(origin, callback) {
    // Allow all origins in development
    if (NODE_ENV === 'development') {
      return callback(null, true);
    }
    
    // Allow requests with no origin (like mobile apps, curl, postman)
    if (!origin) {
      return callback(null, true);
    }
    
    const allowedOrigins = [
      'http://localhost:3000',      // React dev server
      'http://localhost:5500',      // VS Code Live Server
      'http://127.0.0.1:5500',      // VS Code Live Server alternative
      'http://localhost:5000',      // Other local frontend
      'http://localhost:8080',      // Another common port
      'https://fronted-hm86.onrender.com', // Your deployed frontend
      process.env.FRONTEND_URL      // From environment variable
    ].filter(Boolean);
    
    if (allowedOrigins.indexOf(origin) !== -1) {
      callback(null, true);
    } else {
      console.log('CORS blocked origin:', origin);
      callback(new Error(`Origin ${origin} not allowed by CORS`));
    }
  },
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS', 'PATCH', 'HEAD'],
  allowedHeaders: ['Content-Type', 'Authorization', 'Accept', 'Origin', 'X-Requested-With'],
  exposedHeaders: ['Authorization'],
  optionsSuccessStatus: 200,
  maxAge: 86400 // 24 hours
};

// ========== ESSENTIAL MIDDLEWARE ==========
app.use(helmet({
  contentSecurityPolicy: false, // Disable for API server
  crossOriginEmbedderPolicy: false,
  crossOriginResourcePolicy: { policy: "cross-origin" }
}));
app.use(cors(corsOptions));
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// Handle preflight requests globally
app.options('*', cors(corsOptions));

// ========== DEBUG MIDDLEWARE (Log all requests) ==========
app.use((req, res, next) => {
  const timestamp = new Date().toISOString();
  console.log(`\n=== ${timestamp} ${req.method} ${req.url} ===`);
  
  // Log headers (but hide Authorization token for security)
  const headers = { ...req.headers };
  if (headers.authorization) {
    headers.authorization = headers.authorization.substring(0, 20) + '...';
  }
  console.log('Headers:', headers);
  
  // Store original send function
  const originalSend = res.send;
  const originalJson = res.json;
  
  // Capture response for logging
  res.send = function(body) {
    console.log('Response:', typeof body === 'string' ? body.substring(0, 200) + (body.length > 200 ? '...' : '') : JSON.stringify(body).substring(0, 200) + '...');
    originalSend.call(this, body);
  };
  
  res.json = function(body) {
    console.log('Response:', JSON.stringify(body).substring(0, 200) + (JSON.stringify(body).length > 200 ? '...' : ''));
    originalJson.call(this, body);
  };
  
  // Log request body if present
  if (req.body && Object.keys(req.body).length > 0) {
    console.log('Request body:', JSON.stringify(req.body, null, 2).substring(0, 200) + '...');
  }
  
  next();
});

// ========== STORAGE (in-memory for now) ==========
let users = [];
let messages = [];
const rooms = ['general', 'random', 'help', 'tech-support'];

// Log storage state periodically
setInterval(() => {
  console.log(`[Storage Stats] Users: ${users.length}, Messages: ${messages.length}`);
}, 30000); // Every 30 seconds

// ========== AUTH MIDDLEWARE ==========
function authenticateToken(req, res, next) {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];
  
  console.log('Auth check - Header:', authHeader ? authHeader.substring(0, 20) + '...' : 'None');
  console.log('Auth check - Token present:', !!token);
  
  if (!token) {
    return res.status(401).json({ 
      success: false, 
      message: 'Access token required' 
    });
  }
  
  jwt.verify(token, JWT_SECRET, (err, user) => {
    if (err) {
      console.log('Token verification failed:', err.message);
      return res.status(403).json({ 
        success: false, 
        message: 'Invalid or expired token' 
      });
    }
    req.user = user;
    console.log('Token verified for user:', user.email);
    next();
  });
}

// ========== HEALTH & STATUS ==========
app.get('/health', (req, res) => {
  // Minimal processing for fast response
  res.setHeader('Cache-Control', 'no-cache');
  res.json({ 
    success: true,
    status: 'OK',
    environment: NODE_ENV,
    timestamp: Date.now(),
    uptime: Math.floor(process.uptime())
  });
});

app.get('/api/status', (req, res) => {
  res.json({
    success: true,
    message: 'MoodChat API is running',
    version: '1.0.0',
    environment: NODE_ENV,
    features: ['auth', 'chat', 'profiles'],
    endpoints: {
      auth: ['/api/auth/register', '/api/auth/login', '/api/auth/profile'],
      chat: ['/api/chat/rooms', '/api/chat/messages/:room', '/api/chat/messages']
    }
  });
});

// Test endpoint for JSON validation
app.post('/api/test-json', (req, res) => {
  console.log('Test JSON endpoint called');
  console.log('Request body:', req.body);
  res.json({
    success: true,
    message: 'JSON received successfully',
    received: req.body,
    timestamp: new Date().toISOString()
  });
});

// ========== AUTH ROUTES ==========
app.post('/api/auth/register', async (req, res) => {
  try {
    console.log('Register request body:', req.body);
    
    const { email, password, username } = req.body;
    
    // Validation
    if (!email || !password || !username) {
      console.log('Missing fields:', { email: !!email, password: !!password, username: !!username });
      return res.status(400).json({
        success: false,
        message: 'Email, password, and username are required',
        received: req.body
      });
    }
    
    // Check if user already exists
    const existingUser = users.find(u => u.email === email);
    if (existingUser) {
      console.log('User already exists:', email);
      return res.status(400).json({
        success: false,
        message: 'User already exists'
      });
    }
    
    // Hash password
    const hashedPassword = await bcrypt.hash(password, 10);
    console.log('Password hashed successfully');
    
    // Create user
    const user = {
      id: users.length + 1,
      email,
      username,
      password: hashedPassword,
      createdAt: new Date(),
      avatar: `https://ui-avatars.com/api/?name=${encodeURIComponent(username)}&background=random`
    };
    
    users.push(user);
    console.log('User created:', { id: user.id, email: user.email, username: user.username });
    
    // Generate token
    const token = jwt.sign(
      { userId: user.id, email: user.email, username: user.username },
      JWT_SECRET,
      { expiresIn: '24h' }
    );
    
    console.log('JWT token generated');
    
    // Respond
    res.status(201).json({
      success: true,
      message: 'User registered successfully',
      token,
      user: {
        id: user.id,
        email: user.email,
        username: user.username,
        avatar: user.avatar,
        createdAt: user.createdAt
      }
    });
    
  } catch (error) {
    console.error('Register error:', error);
    res.status(500).json({
      success: false,
      message: 'Registration failed',
      error: error.message
    });
  }
});

app.post('/api/auth/login', async (req, res) => {
  try {
    console.log('Login request body:', req.body);
    
    const { email, password } = req.body;
    
    // Validation
    if (!email || !password) {
      return res.status(400).json({
        success: false,
        message: 'Email and password are required'
      });
    }
    
    // Find user
    const user = users.find(u => u.email === email);
    console.log('User found:', user ? 'Yes' : 'No');
    
    if (!user) {
      return res.status(401).json({
        success: false,
        message: 'Invalid credentials'
      });
    }
    
    // Check password
    console.log('Comparing password...');
    const validPassword = await bcrypt.compare(password, user.password);
    console.log('Password valid:', validPassword);
    
    if (!validPassword) {
      return res.status(401).json({
        success: false,
        message: 'Invalid credentials'
      });
    }
    
    // Generate token
    const token = jwt.sign(
      { userId: user.id, email: user.email, username: user.username },
      JWT_SECRET,
      { expiresIn: '24h' }
    );
    
    console.log('Login successful for:', email);
    
    res.json({
      success: true,
      message: 'Login successful',
      token,
      user: {
        id: user.id,
        email: user.email,
        username: user.username,
        avatar: user.avatar,
        createdAt: user.createdAt
      }
    });
    
  } catch (error) {
    console.error('Login error:', error);
    res.status(500).json({
      success: false,
      message: 'Login failed',
      error: error.message
    });
  }
});

app.get('/api/auth/profile', authenticateToken, (req, res) => {
  try {
    console.log('Profile request for user:', req.user.userId);
    
    const user = users.find(u => u.id === req.user.userId);
    
    if (!user) {
      return res.status(404).json({
        success: false,
        message: 'User not found'
      });
    }
    
    res.json({
      success: true,
      user: {
        id: user.id,
        email: user.email,
        username: user.username,
        avatar: user.avatar,
        createdAt: user.createdAt
      }
    });
    
  } catch (error) {
    console.error('Profile error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to get profile',
      error: error.message
    });
  }
});

// ========== CHAT ROUTES ==========
app.get('/api/chat/rooms', authenticateToken, (req, res) => {
  console.log('Fetching rooms for user:', req.user.userId);
  
  res.json({
    success: true,
    rooms: rooms.map(room => ({
      name: room,
      messageCount: messages.filter(m => m.room === room).length,
      lastMessage: messages.filter(m => m.room === room).slice(-1)[0] || null
    }))
  });
});

app.get('/api/chat/messages/:room', authenticateToken, (req, res) => {
  console.log('Fetching messages for room:', req.params.room, 'user:', req.user.userId);
  
  const roomMessages = messages
    .filter(m => m.room === req.params.room)
    .slice(-50);
  
  res.json({
    success: true,
    room: req.params.room,
    messages: roomMessages
  });
});

app.post('/api/chat/messages', authenticateToken, (req, res) => {
  try {
    console.log('Send message request:', req.body);
    
    const { room, content } = req.body;
    const user = users.find(u => u.id === req.user.userId);
    
    if (!room || !content) {
      return res.status(400).json({ 
        success: false, 
        message: 'Room and message content are required' 
      });
    }
    
    if (!rooms.includes(room)) {
      return res.status(400).json({ 
        success: false, 
        message: 'Invalid room' 
      });
    }
    
    const message = {
      id: messages.length + 1,
      room,
      content,
      sender: {
        id: user.id,
        username: user.username,
        avatar: user.avatar
      },
      timestamp: new Date().toISOString()
    };
    
    messages.push(message);
    console.log('Message sent:', message.id);
    
    res.json({
      success: true,
      message: 'Message sent successfully',
      data: message
    });
    
  } catch (error) {
    console.error('Send message error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to send message',
      error: error.message
    });
  }
});

// ========== ERROR HANDLING ==========
// 404 handler
app.use((req, res) => {
  console.log('404 Not Found:', req.method, req.url);
  res.status(404).json({
    success: false,
    message: `Cannot ${req.method} ${req.url}`,
    availableEndpoints: {
      GET: ['/health', '/api/status', '/api/auth/profile', '/api/chat/rooms', '/api/chat/messages/:room'],
      POST: ['/api/auth/register', '/api/auth/login', '/api/chat/messages', '/api/test-json']
    }
  });
});

// Global error handler
app.use((err, req, res, next) => {
  console.error('Global error handler:', err);
  res.status(500).json({
    success: false,
    message: 'Internal server error',
    error: NODE_ENV === 'development' ? err.message : undefined
  });
});

// ========== START SERVER ==========
const startServer = () => {
  const server = app.listen(PORT, '0.0.0.0', () => {
    console.log(`┌──────────────────────────────────────────────────────────┐`);
    console.log(`│                                                          │`);
    console.log(`│   🚀 MoodChat Server started successfully!               │`);
    console.log(`│                                                          │`);
    console.log(`│   📍 HTTP Server:    http://localhost:${PORT}            ${PORT < 1000 ? ' ' : ''}`);
    console.log(`│   🌐 Environment:    ${NODE_ENV}                         `);
    console.log(`│   📊 JWT Secret:     ${JWT_SECRET.substring(0, 10)}...   `);
    console.log(`│                                                          │`);
    console.log(`│   📊 Health Check:   http://localhost:${PORT}/health     ${PORT < 1000 ? ' ' : ''}`);
    console.log(`│   🔐 Auth Routes:    http://localhost:${PORT}/api/auth/* ${PORT < 1000 ? ' ' : ''}`);
    console.log(`│   💬 Chat Routes:    http://localhost:${PORT}/api/chat/* ${PORT < 1000 ? ' ' : ''}`);
    console.log(`│   🐞 Debug Endpoint: http://localhost:${PORT}/api/test-json`);
    console.log(`│                                                          │`);
    console.log(`│   Press Ctrl+C to stop the server                        │`);
    console.log(`│                                                          │`);
    console.log(`└──────────────────────────────────────────────────────────┘`);
  });

  // ========== GRACEFUL SHUTDOWN HANDLERS ==========
  const shutdown = (signal) => {
    console.log(`\n${signal} received. Starting graceful shutdown...`);
    
    server.close(() => {
      console.log('HTTP server closed.');
      console.log('Shutdown complete. Goodbye!');
      process.exit(0);
    });

    // Force shutdown after 10 seconds
    setTimeout(() => {
      console.error('Could not close connections in time, forcefully shutting down');
      process.exit(1);
    }, 10000);
  };

  // Handle termination signals
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

  // Handle uncaught errors and rejections
  process.on('uncaughtException', (error) => {
    console.error('Uncaught Exception:', error);
    // Don't exit, keep server running
  });

  process.on('unhandledRejection', (reason, promise) => {
    console.error('Unhandled Rejection at:', promise, 'reason:', reason);
    // Don't exit, keep server running
  });

  // Handle server-specific errors
  server.on('error', (error) => {
    if (error.code === 'EADDRINUSE') {
      console.error(`Port ${PORT} is already in use.`);
      process.exit(1);
    } else {
      console.error('Server error:', error);
    }
  });

  return server;
};

// Start the server
const server = startServer();

// Keep process alive
setInterval(() => {
  // Keep the event loop alive
}, 1000 * 60 * 60); // Run every hour