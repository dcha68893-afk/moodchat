﻿// src/server.js - OPTIMIZED VERSION FOR MOODCHAT BACKEND
require('dotenv').config();
const express = require('express');
const cors = require('cors');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const helmet = require('helmet');
const path = require('path');

const app = express();

// ========== CONFIGURATION ==========
const PORT = process.env.PORT || 3000;
const NODE_ENV = process.env.NODE_ENV || 'development';
const JWT_SECRET = process.env.JWT_ACCESS_SECRET || process.env.JWT_SECRET || 'development-secret-key-change-in-production';
const FRONTEND_URL = process.env.FRONTEND_URL || 'http://localhost:3000';

// ========== ESSENTIAL MIDDLEWARE ==========
// Disable Helmet's CSP for API server
app.use(helmet({
  contentSecurityPolicy: false,
  crossOriginEmbedderPolicy: false,
  crossOriginResourcePolicy: { policy: "cross-origin" }
}));

// ========== FIXED CORS CONFIGURATION ==========
// ALLOW ALL ORIGINS IN DEVELOPMENT - This fixes Live Server issues
if (NODE_ENV === 'development') {
  // Simple CORS for development - allow everything
  app.use(cors({
    origin: '*', // Allow ALL origins
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS', 'PATCH', 'HEAD'],
    allowedHeaders: ['Content-Type', 'Authorization', 'Accept', 'Origin', 'X-Requested-With', 'X-Device-ID', 'X-Request-ID'],
    exposedHeaders: ['Authorization'],
    optionsSuccessStatus: 200,
    maxAge: 86400 // 24 hours
  }));
  
  // Also add manual CORS headers as backup
  app.use((req, res, next) => {
    res.header('Access-Control-Allow-Origin', '*');
    res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept, Authorization, X-Device-ID, X-Request-ID');
    res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS, PATCH, HEAD');
    res.header('Access-Control-Allow-Credentials', 'true');
    next();
  });
} else {
  // Production CORS - more restrictive
  const corsOptions = {
    origin: function(origin, callback) {
      const allowedOrigins = [
        'http://localhost:3000',
        'http://localhost:5500',
        'http://127.0.0.1:5500',
        'http://localhost:5000',
        'http://localhost:8080',
        'https://fronted-hm86.onrender.com',
        FRONTEND_URL
      ].filter(Boolean);
      
      // Allow no origin (like mobile apps)
      if (!origin) return callback(null, true);
      
      if (allowedOrigins.includes(origin)) {
        callback(null, true);
      } else {
        console.log('CORS blocked origin:', origin);
        callback(new Error(`Origin ${origin} not allowed by CORS`));
      }
    },
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS', 'PATCH', 'HEAD'],
    allowedHeaders: ['Content-Type', 'Authorization', 'Accept', 'Origin', 'X-Requested-With', 'X-Device-ID'],
    exposedHeaders: ['Authorization'],
    optionsSuccessStatus: 200,
    maxAge: 86400
  };
  
  app.use(cors(corsOptions));
}

app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// Handle preflight requests globally
app.options('*', (req, res) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept, Authorization, X-Device-ID');
  res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS, PATCH, HEAD');
  res.header('Access-Control-Allow-Credentials', 'true');
  res.header('Access-Control-Max-Age', '86400');
  res.sendStatus(200);
});

// ========== REQUEST LOGGING MIDDLEWARE ==========
app.use((req, res, next) => {
  const timestamp = new Date().toISOString();
  console.log(`[${timestamp}] ${req.method} ${req.path} - Origin: ${req.headers.origin || 'no-origin'}`);
  
  // Log request body for POST, PUT, PATCH
  if (['POST', 'PUT', 'PATCH'].includes(req.method) && req.body && Object.keys(req.body).length > 0) {
    const logBody = { ...req.body };
    if (logBody.password) logBody.password = '[REDACTED]';
    if (logBody.token) logBody.token = '[REDACTED]';
    console.log('Request Body:', JSON.stringify(logBody).substring(0, 500));
  }
  
  // Log headers for debugging
  if (NODE_ENV === 'development') {
    console.log('Headers:', {
      origin: req.headers.origin,
      authorization: req.headers.authorization ? '[PRESENT]' : '[MISSING]',
      'x-device-id': req.headers['x-device-id'],
      'x-requested-with': req.headers['x-requested-with']
    });
  }
  
  next();
});

// ========== STATIC FILE SERVING ==========
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));
app.use('/assets', express.static(path.join(__dirname, 'public/assets')));
app.use(express.static(path.join(__dirname, 'public')));

// ========== IN-MEMORY STORAGE ==========
let users = [];
let messages = [];
const rooms = ['general', 'random', 'help', 'tech-support'];

// Log storage state periodically
setInterval(() => {
  console.log(`[Storage Stats] Users: ${users.length}, Messages: ${messages.length}, Rooms: ${rooms.length}`);
}, 30000); // Every 30 seconds

// ========== AUTHENTICATION MIDDLEWARE ==========
function authenticateToken(req, res, next) {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];
  
  if (!token) {
    return res.status(401).json({ 
      success: false, 
      message: 'Access token required',
      timestamp: new Date().toISOString()
    });
  }
  
  jwt.verify(token, JWT_SECRET, (err, user) => {
    if (err) {
      console.log('JWT Verification Error:', err.message);
      return res.status(403).json({ 
        success: false, 
        message: 'Invalid or expired token',
        timestamp: new Date().toISOString()
      });
    }
    req.user = user;
    next();
  });
}

// ========== HEALTH & STATUS ENDPOINTS ==========
app.get('/health', (req, res) => {
  res.setHeader('Cache-Control', 'no-cache');
  res.json({ 
    success: true,
    status: 'OK',
    environment: NODE_ENV,
    timestamp: new Date().toISOString(),
    uptime: Math.floor(process.uptime()),
    cors: 'enabled',
    allowedOrigins: NODE_ENV === 'development' ? 'ALL (*)' : 'restricted'
  });
});

app.get('/api/status', (req, res) => {
  res.json({
    success: true,
    message: 'Backend API running',
    timestamp: new Date().toISOString(),
    environment: NODE_ENV,
    version: '1.0.0',
    server: 'MoodChat Backend',
    cors: 'enabled',
    origin: req.headers.origin || 'not specified',
    endpoints: {
      health: '/health',
      status: '/api/status',
      auth: {
        register: 'POST /api/register',
        login: 'POST /api/login',
        profile: 'GET /api/auth/profile'
      },
      chat: {
        rooms: 'GET /api/chat/rooms',
        messages: 'GET /api/chat/messages/:room',
        send: 'POST /api/chat/messages'
      }
    }
  });
});

// Add /api/health endpoint
app.get('/api/health', (req, res) => {
  res.status(200).json({
    success: true,
    status: 200,
    message: 'Backend API running',
    service: 'moodchat-backend',
    timestamp: new Date().toISOString()
  });
});

// Simple test endpoint for debugging
app.get('/api/debug', (req, res) => {
  res.json({
    success: true,
    timestamp: new Date().toISOString(),
    headers: {
      origin: req.headers.origin,
      'user-agent': req.headers['user-agent'],
      'x-device-id': req.headers['x-device-id']
    },
    cors: 'ALLOWED'
  });
});

// Test endpoint for JSON validation
app.post('/api/test-json', (req, res) => {
  res.json({
    success: true,
    message: 'JSON received successfully',
    received: req.body,
    timestamp: new Date().toISOString(),
    environment: NODE_ENV
  });
});

// ========== CLOUDINARY ROUTES (if they exist) ==========
// Add Cloudinary upload/sign routes here if they exist in your application
app.post('/api/cloudinary/upload', (req, res) => {
  // Mock Cloudinary upload endpoint - you should replace this with your actual implementation
  res.json({
    success: true,
    message: 'Cloudinary upload endpoint',
    timestamp: new Date().toISOString()
  });
});

app.post('/api/cloudinary/sign', (req, res) => {
  // Mock Cloudinary sign endpoint - you should replace this with your actual implementation
  res.json({
    success: true,
    signature: 'mock-signature',
    timestamp: new Date().toISOString()
  });
});

// ========== AUTHENTICATION ROUTES (mounted under /api) ==========
// POST /api/register - Register a new user
app.post('/api/register', async (req, res) => {
  try {
    const { email, password, username } = req.body;
    
    // Validation
    if (!email || !password || !username) {
      return res.status(400).json({
        success: false,
        message: 'Email, password, and username are required',
        timestamp: new Date().toISOString()
      });
    }
    
    // Check if user already exists
    const existingUser = users.find(u => u.email === email);
    if (existingUser) {
      return res.status(400).json({
        success: false,
        message: 'User already exists',
        timestamp: new Date().toISOString()
      });
    }
    
    // Hash password
    const hashedPassword = await bcrypt.hash(password, 10);
    
    // Create user
    const user = {
      id: Date.now().toString(),
      email,
      username,
      password: hashedPassword,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      avatar: `https://ui-avatars.com/api/?name=${encodeURIComponent(username)}&background=random&color=fff`
    };
    
    users.push(user);
    
    // Generate token
    const token = jwt.sign(
      { 
        userId: user.id, 
        email: user.email, 
        username: user.username 
      },
      JWT_SECRET,
      { expiresIn: '24h' }
    );
    
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
      },
      timestamp: new Date().toISOString()
    });
    
  } catch (error) {
    console.error('Register error:', error);
    res.status(500).json({
      success: false,
      message: 'Registration failed',
      error: NODE_ENV === 'development' ? error.message : undefined,
      timestamp: new Date().toISOString()
    });
  }
});

// POST /api/login - Login existing user
app.post('/api/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    
    // Also accept username for login
    let user;
    if (email.includes('@')) {
      user = users.find(u => u.email === email);
    } else {
      user = users.find(u => u.username === email); // Allow username login
    }
    
    if (!user) {
      return res.status(401).json({
        success: false,
        message: 'Invalid credentials',
        timestamp: new Date().toISOString()
      });
    }
    
    // Check password
    const validPassword = await bcrypt.compare(password, user.password);
    
    if (!validPassword) {
      return res.status(401).json({
        success: false,
        message: 'Invalid credentials',
        timestamp: new Date().toISOString()
      });
    }
    
    // Generate token
    const token = jwt.sign(
      { 
        userId: user.id, 
        email: user.email, 
        username: user.username 
      },
      JWT_SECRET,
      { expiresIn: '24h' }
    );
    
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
      },
      timestamp: new Date().toISOString()
    });
    
  } catch (error) {
    console.error('Login error:', error);
    res.status(500).json({
      success: false,
      message: 'Login failed',
      error: NODE_ENV === 'development' ? error.message : undefined,
      timestamp: new Date().toISOString()
    });
  }
});

// POST /api/logout - Logout user (invalidate token on client side)
app.post('/api/logout', (req, res) => {
  res.json({
    success: true,
    message: 'Logged out successfully (client should discard token)',
    timestamp: new Date().toISOString()
  });
});

// ========== COMPATIBILITY AUTH ROUTES (keep existing) ==========
// These are kept for compatibility with existing code
app.post('/api/auth/register', async (req, res) => {
  try {
    const { email, password, username } = req.body;
    
    // Validation
    if (!email || !password || !username) {
      return res.status(400).json({
        success: false,
        message: 'Email, password, and username are required',
        timestamp: new Date().toISOString()
      });
    }
    
    // Check if user already exists
    const existingUser = users.find(u => u.email === email);
    if (existingUser) {
      return res.status(400).json({
        success: false,
        message: 'User already exists',
        timestamp: new Date().toISOString()
      });
    }
    
    // Hash password
    const hashedPassword = await bcrypt.hash(password, 10);
    
    // Create user
    const user = {
      id: Date.now().toString(),
      email,
      username,
      password: hashedPassword,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      avatar: `https://ui-avatars.com/api/?name=${encodeURIComponent(username)}&background=random&color=fff`
    };
    
    users.push(user);
    
    // Generate token
    const token = jwt.sign(
      { 
        userId: user.id, 
        email: user.email, 
        username: user.username 
      },
      JWT_SECRET,
      { expiresIn: '24h' }
    );
    
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
      },
      timestamp: new Date().toISOString()
    });
    
  } catch (error) {
    console.error('Register error:', error);
    res.status(500).json({
      success: false,
      message: 'Registration failed',
      error: NODE_ENV === 'development' ? error.message : undefined,
      timestamp: new Date().toISOString()
    });
  }
});

app.post('/api/auth/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    
    // Also accept username for login
    let user;
    if (email.includes('@')) {
      user = users.find(u => u.email === email);
    } else {
      user = users.find(u => u.username === email); // Allow username login
    }
    
    if (!user) {
      return res.status(401).json({
        success: false,
        message: 'Invalid credentials',
        timestamp: new Date().toISOString()
      });
    }
    
    // Check password
    const validPassword = await bcrypt.compare(password, user.password);
    
    if (!validPassword) {
      return res.status(401).json({
        success: false,
        message: 'Invalid credentials',
        timestamp: new Date().toISOString()
      });
    }
    
    // Generate token
    const token = jwt.sign(
      { 
        userId: user.id, 
        email: user.email, 
        username: user.username 
      },
      JWT_SECRET,
      { expiresIn: '24h' }
    );
    
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
      },
      timestamp: new Date().toISOString()
    });
    
  } catch (error) {
    console.error('Login error:', error);
    res.status(500).json({
      success: false,
      message: 'Login failed',
      error: NODE_ENV === 'development' ? error.message : undefined,
      timestamp: new Date().toISOString()
    });
  }
});

app.get('/api/auth/me', authenticateToken, (req, res) => {
  try {
    const user = users.find(u => u.id === req.user.userId);
    
    if (!user) {
      return res.status(404).json({
        success: false,
        message: 'User not found',
        timestamp: new Date().toISOString()
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
      },
      timestamp: new Date().toISOString()
    });
    
  } catch (error) {
    console.error('Profile error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to get profile',
      error: NODE_ENV === 'development' ? error.message : undefined,
      timestamp: new Date().toISOString()
    });
  }
});

// Alias for /api/auth/profile (for compatibility)
app.get('/api/auth/profile', authenticateToken, (req, res) => {
  try {
    const user = users.find(u => u.id === req.user.userId);
    
    if (!user) {
      return res.status(404).json({
        success: false,
        message: 'User not found',
        timestamp: new Date().toISOString()
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
      },
      timestamp: new Date().toISOString()
    });
    
  } catch (error) {
    console.error('Profile error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to get profile',
      error: NODE_ENV === 'development' ? error.message : undefined,
      timestamp: new Date().toISOString()
    });
  }
});

// ========== CHAT ROUTES ==========
app.get('/api/chat/rooms', authenticateToken, (req, res) => {
  try {
    const roomsWithStats = rooms.map(room => {
      const roomMessages = messages.filter(m => m.room === room);
      const lastMessage = roomMessages.slice(-1)[0];
      
      return {
        name: room,
        messageCount: roomMessages.length,
        lastMessage: lastMessage ? {
          content: lastMessage.content,
          sender: lastMessage.sender.username,
          timestamp: lastMessage.timestamp
        } : null
      };
    });
    
    res.json({
      success: true,
      rooms: roomsWithStats,
      timestamp: new Date().toISOString()
    });
    
  } catch (error) {
    console.error('Rooms error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch rooms',
      error: NODE_ENV === 'development' ? error.message : undefined,
      timestamp: new Date().toISOString()
    });
  }
});

app.get('/api/chat/messages/:room', authenticateToken, (req, res) => {
  try {
    const { room } = req.params;
    
    if (!rooms.includes(room)) {
      return res.status(400).json({
        success: false,
        message: 'Invalid room',
        timestamp: new Date().toISOString()
      });
    }
    
    const roomMessages = messages
      .filter(m => m.room === room)
      .slice(-100); // Last 100 messages
    
    res.json({
      success: true,
      room,
      messages: roomMessages,
      count: roomMessages.length,
      timestamp: new Date().toISOString()
    });
    
  } catch (error) {
    console.error('Messages error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch messages',
      error: NODE_ENV === 'development' ? error.message : undefined,
      timestamp: new Date().toISOString()
    });
  }
});

app.post('/api/chat/messages', authenticateToken, (req, res) => {
  try {
    const { room, content } = req.body;
    const user = users.find(u => u.id === req.user.userId);
    
    if (!room || !content) {
      return res.status(400).json({
        success: false,
        message: 'Room and message content are required',
        timestamp: new Date().toISOString()
      });
    }
    
    if (!rooms.includes(room)) {
      return res.status(400).json({
        success: false,
        message: 'Invalid room',
        timestamp: new Date().toISOString()
      });
    }
    
    const message = {
      id: Date.now().toString(),
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
    
    res.json({
      success: true,
      message: 'Message sent successfully',
      data: message,
      timestamp: new Date().toISOString()
    });
    
  } catch (error) {
    console.error('Send message error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to send message',
      error: NODE_ENV === 'development' ? error.message : undefined,
      timestamp: new Date().toISOString()
    });
  }
});

// ========== ADDITIONAL UTILITY ENDPOINTS ==========
app.get('/api/stats', authenticateToken, (req, res) => {
  res.json({
    success: true,
    stats: {
      totalUsers: users.length,
      totalMessages: messages.length,
      totalRooms: rooms.length,
      activeUsers: users.length,
      messagesPerRoom: rooms.reduce((acc, room) => {
        acc[room] = messages.filter(m => m.room === room).length;
        return acc;
      }, {})
    },
    timestamp: new Date().toISOString()
  });
});

app.get('/api/user/search', authenticateToken, (req, res) => {
  try {
    const { query } = req.query;
    
    if (!query) {
      return res.status(400).json({
        success: false,
        message: 'Search query is required',
        timestamp: new Date().toISOString()
      });
    }
    
    const searchResults = users
      .filter(user => 
        user.username.toLowerCase().includes(query.toLowerCase()) ||
        user.email.toLowerCase().includes(query.toLowerCase())
      )
      .map(user => ({
        id: user.id,
        username: user.username,
        avatar: user.avatar,
        createdAt: user.createdAt
      }));
    
    res.json({
      success: true,
      results: searchResults,
      count: searchResults.length,
      timestamp: new Date().toISOString()
    });
    
  } catch (error) {
    console.error('Search error:', error);
    res.status(500).json({
      success: false,
      message: 'Search failed',
      error: NODE_ENV === 'development' ? error.message : undefined,
      timestamp: new Date().toISOString()
    });
  }
});

// ========== ADD MORE ENDPOINTS FOR YOUR API.JS ==========
// Add endpoints that your api.js expects

// Friends endpoints (mock for now)
app.get('/api/friends/list', authenticateToken, (req, res) => {
  res.json({
    success: true,
    friends: [],
    timestamp: new Date().toISOString()
  });
});

// Statuses endpoints (mock for now)
app.get('/api/statuses/all', authenticateToken, (req, res) => {
  res.json({
    success: true,
    statuses: [],
    timestamp: new Date().toISOString()
  });
});

// Groups endpoints (mock for now)
app.get('/api/groups/list', authenticateToken, (req, res) => {
  res.json({
    success: true,
    groups: [],
    timestamp: new Date().toISOString()
  });
});

// Chats endpoints (mock for now)
app.get('/api/chats/list', authenticateToken, (req, res) => {
  res.json({
    success: true,
    chats: [],
    timestamp: new Date().toISOString()
  });
});

// ========== STATIC HTML PAGE ROUTES ==========
// These routes serve your HTML pages from the public directory
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.get('/login', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'login.html'));
});

app.get('/register', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'register.html'));
});

app.get('/chat', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'chat.html'));
});

// Add any other static page routes your app needs
app.get('/dashboard', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'dashboard.html'));
});

// ========== ERROR HANDLING ==========
// 404 handler
app.use((req, res) => {
  res.status(404).json({
    success: false,
    message: `Cannot ${req.method} ${req.url}`,
    timestamp: new Date().toISOString(),
    availableEndpoints: {
      GET: [
        '/',
        '/login',
        '/register',
        '/chat',
        '/dashboard',
        '/health',
        '/api/status',
        '/api/health',
        '/api/debug',
        '/api/auth/me',
        '/api/auth/profile',
        '/api/chat/rooms',
        '/api/chat/messages/:room',
        '/api/stats',
        '/api/user/search',
        '/api/friends/list',
        '/api/statuses/all',
        '/api/groups/list',
        '/api/chats/list'
      ],
      POST: [
        '/api/register',
        '/api/login',
        '/api/logout',
        '/api/auth/register',
        '/api/auth/login',
        '/api/chat/messages',
        '/api/test-json',
        '/api/cloudinary/upload',
        '/api/cloudinary/sign'
      ],
      OPTIONS: ['*'] // All endpoints support OPTIONS for CORS
    }
  });
});

// Global error handler
app.use((err, req, res, next) => {
  console.error('Global error handler:', err);
  
  // Handle CORS errors
  if (err.message.includes('CORS')) {
    return res.status(403).json({
      success: false,
      message: 'CORS error: ' + err.message,
      timestamp: new Date().toISOString(),
      allowedOrigins: NODE_ENV === 'development' ? 'ALL (*)' : 'restricted'
    });
  }
  
  res.status(err.status || 500).json({
    success: false,
    message: 'Internal server error',
    error: NODE_ENV === 'development' ? err.message : undefined,
    timestamp: new Date().toISOString()
  });
});

// ========== START SERVER ==========
const startServer = () => {
  const server = app.listen(PORT, '0.0.0.0', () => {
    console.log(`┌──────────────────────────────────────────────────────────┐`);
    console.log(`│                                                          │`);
    console.log(`│   🚀 MoodChat Backend Server Started                     │`);
    console.log(`│                                                          │`);
    console.log(`│   📍 Local:    http://localhost:${PORT}                  ${PORT < 1000 ? ' ' : ''}`);
    console.log(`│   🌐 Env:      ${NODE_ENV}                               `);
    console.log(`│   ⏱️  Time:     ${new Date().toLocaleString()}           `);
    console.log(`│   🔓 CORS:     ${NODE_ENV === 'development' ? 'ALLOW ALL ORIGINS' : 'RESTRICTED'}    `);
    console.log(`│                                                          │`);
    console.log(`│   📊 Health:   http://localhost:${PORT}/health           ${PORT < 1000 ? ' ' : ''}`);
    console.log(`│   🔐 Status:   http://localhost:${PORT}/api/status       ${PORT < 1000 ? ' ' : ''}`);
    console.log(`│   🏥 API Health: http://localhost:${PORT}/api/health     ${PORT < 1000 ? ' ' : ''}`);
    console.log(`│   🐛 Debug:    http://localhost:${PORT}/api/debug        ${PORT < 1000 ? ' ' : ''}`);
    console.log(`│   💬 API Base: http://localhost:${PORT}/api              ${PORT < 1000 ? ' ' : ''}`);
    console.log(`│                                                          │`);
    console.log(`│   📄 Pages:                                               │`);
    console.log(`│   • Home:      http://localhost:${PORT}/                 ${PORT < 1000 ? ' ' : ''}`);
    console.log(`│   • Login:     http://localhost:${PORT}/login            ${PORT < 1000 ? ' ' : ''}`);
    console.log(`│   • Register:  http://localhost:${PORT}/register         ${PORT < 1000 ? ' ' : ''}`);
    console.log(`│   • Chat:      http://localhost:${PORT}/chat             ${PORT < 1000 ? ' ' : ''}`);
    console.log(`│                                                          │`);
    console.log(`│   Press Ctrl+C to stop                                   │`);
    console.log(`│                                                          │`);
    console.log(`└──────────────────────────────────────────────────────────┘`);
  });

  // Graceful shutdown handlers
  const shutdown = (signal) => {
    console.log(`\n${signal} received. Starting graceful shutdown...`);
    
    server.close(() => {
      console.log('HTTP server closed.');
      console.log('Shutdown complete. Goodbye!');
      process.exit(0);
    });

    setTimeout(() => {
      console.error('Could not close connections in time, forcefully shutting down');
      process.exit(1);
    }, 10000);
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

  process.on('uncaughtException', (error) => {
    console.error('Uncaught Exception:', error);
  });

  process.on('unhandledRejection', (reason, promise) => {
    console.error('Unhandled Rejection at:', promise, 'reason:', reason);
  });

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
if (require.main === module) {
  startServer();
}

module.exports = app;