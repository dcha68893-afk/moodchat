﻿// src/server.js - UPDATED PRODUCTION VERSION FOR MOODCHAT BACKEND
require('dotenv').config();
const express = require('express');
const cors = require('cors');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const helmet = require('helmet');
const path = require('path');
const fs = require('fs'); // Added for file system operations to mount routes
const { Sequelize } = require('sequelize');

const app = express();

// ========== CONFIGURATION ==========
const PORT = process.env.PORT || 3000;
const NODE_ENV = process.env.NODE_ENV || 'development';
const JWT_SECRET = process.env.JWT_ACCESS_SECRET || process.env.JWT_SECRET || 'development-secret-key-change-in-production';
const FRONTEND_URL = process.env.FRONTEND_URL || 'http://localhost:3000';

// ========== DATABASE CONNECTION - FIXED ==========
// Initialize database connection variables
let sequelize;
let dbConnected = false;
let models;

// Function to initialize database connection
async function initializeDatabase() {
  try {
    // Direct Sequelize initialization using environment variables
    sequelize = new Sequelize(
      process.env.DB_NAME || 'moodchat',
      process.env.DB_USER || 'postgres',
      process.env.DB_PASSWORD || '24845c1b4df84c17a0526806f7aa0482',
      {
        host: process.env.DB_HOST || '127.0.0.1',
        port: process.env.DB_PORT || 5432,
        dialect: process.env.DB_DIALECT || 'postgres',
        logging: process.env.NODE_ENV === 'development' ? console.log : false,
        pool: {
          max: 10,
          min: 0,
          acquire: 30000,
          idle: 10000
        },
        dialectOptions: NODE_ENV === 'production' && process.env.DB_SSL === 'true' ? {
          ssl: {
            require: true,
            rejectUnauthorized: false
          }
        } : {}
      }
    );
    
    // Test database connection
    console.log('🔌 Testing database connection...');
    await sequelize.authenticate();
    dbConnected = true;
    console.log('✅ Database connection established successfully.');
    
    // Import models from the correct location
    try {
      models = require('./models/index.js');
      console.log('📦 Models loaded successfully from models/index.js');
      
      // Log all models that were loaded
      const modelNames = Object.keys(models).filter(key => 
        key !== 'sequelize' && key !== 'Sequelize' && !key.startsWith('_')
      );
      console.log(`📦 Loaded ${modelNames.length} models:`, modelNames.join(', '));
    } catch (modelError) {
      console.warn('⚠️  Could not load models from models/index.js:', modelError.message);
      models = {};
    }
    
    // Sync models only if configured (use with caution in production)
    if (process.env.DB_SYNC === 'true' && NODE_ENV !== 'production') {
      console.log('🔄 Syncing database models...');
      await sequelize.sync({ alter: true });
      console.log('✅ Database models synced.');
    } else if (process.env.DB_SYNC === 'true' && NODE_ENV === 'production') {
      console.warn('⚠️  DB_SYNC=true is not recommended in production. Use migrations instead.');
    }
    
    return true;
    
  } catch (error) {
    console.error('❌ Database connection failed:', error.message);
    
    // More detailed error information for debugging
    console.error('Error details:', {
      name: error.name,
      code: error.code,
      original: error.original,
      stack: error.stack ? error.stack.split('\n')[0] : 'No stack trace'
    });
    
    // Fail in production if database is required
    if (NODE_ENV === 'production' && process.env.DB_REQUIRED === 'true') {
      console.error('💀 CRITICAL: Cannot start without database connection in production');
      process.exit(1);
    }
    
    return false;
  }
}

// Initialize database connection
initializeDatabase().then(success => {
  dbConnected = success;
}).catch(err => {
  console.error('❌ Unexpected error during database initialization:', err);
});

// ========== ESSENTIAL MIDDLEWARE ==========
// Disable Helmet's CSP for API server
app.use(helmet({
  contentSecurityPolicy: false,
  crossOriginEmbedderPolicy: false,
  crossOriginResourcePolicy: { policy: "cross-origin" }
}));

// ========== FIXED: JSON & URLENCODED PARSING - MUST BE BEFORE ROUTES ==========
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

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

// Handle preflight requests globally
app.options('*', (req, res) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept, Authorization, X-Device-ID');
  res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS, PATCH, HEAD');
  res.header('Access-Control-Allow-Credentials', 'true');
  res.header('Access-Control-Max-Age', '86400');
  res.sendStatus(200);
});

// ========== TEMPORARY REQUEST LOGGER FOR AUTH ROUTES ==========
app.use((req, res, next) => {
  const timestamp = new Date().toISOString();
  
  // Always log basic info
  console.log(`[${timestamp}] ${req.method} ${req.path} - Origin: ${req.headers.origin || 'no-origin'}`);
  
  // Log request body for /api/auth/* routes
  if (req.path.startsWith('/api/auth/')) {
    console.log(`[AUTH LOG] ${req.method} ${req.path} - Body:`, req.body ? JSON.stringify(req.body) : 'No body');
  }
  
  // Log request body for POST, PUT, PATCH on other routes (except sensitive info)
  if (['POST', 'PUT', 'PATCH'].includes(req.method) && req.body && Object.keys(req.body).length > 0) {
    const logBody = { ...req.body };
    if (logBody.password) logBody.password = '[REDACTED]';
    if (logBody.confirmPassword) logBody.confirmPassword = '[REDACTED]';
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

// ========== MOUNT ALL EXISTING API ROUTES - FIXED ==========
// CRITICAL FIX: Mount routes from routes directory under /api prefix
const mountedRoutes = [];
const routesPath = path.join(__dirname, 'routes');

// Function to mount all routes from the routes directory
function mountRoutes() {
  // Check if routes directory exists
  if (fs.existsSync(routesPath)) {
    console.log(`📁 Routes directory found at: ${routesPath}`);
    
    // Read all route files
    const routeFiles = fs.readdirSync(routesPath).filter(file => file.endsWith('.js'));
    
    if (routeFiles.length === 0) {
      console.warn('⚠️  No route files found in routes directory');
    } else {
      console.log(`📋 Found ${routeFiles.length} route file(s):`, routeFiles);
      
      // Mount each route file
      routeFiles.forEach(file => {
        try {
          const routeName = file.replace('.js', '');
          const routePath = path.join(routesPath, file);
          
          // Clear require cache to ensure fresh import
          delete require.cache[require.resolve(routePath)];
          
          // Import the route module
          const routeModule = require(routePath);
          
          // Determine the base path for the route
          let basePath = `/api/${routeName}`;
          
          // Special handling for index.js
          if (file === 'index.js') {
            basePath = '/api';
          }
          
          // Check if the route file exports a router
          if (routeModule && typeof routeModule === 'function') {
            // Mount the router
            app.use(basePath, routeModule);
            mountedRoutes.push(`${basePath}/*`);
            console.log(`✅ Mounted ${file} at ${basePath}`);
          } else if (routeModule && routeModule.router && typeof routeModule.router === 'function') {
            // Some routes export { router }
            app.use(basePath, routeModule.router);
            mountedRoutes.push(`${basePath}/*`);
            console.log(`✅ Mounted ${file} (router export) at ${basePath}`);
          } else {
            console.warn(`⚠️  Route file ${file} does not export a valid router`);
          }
        } catch (error) {
          console.error(`❌ Failed to mount route ${file}:`, error.message);
          console.error('Error details:', error.stack ? error.stack.split('\n')[0] : 'No stack trace');
        }
      });
    }
  } else {
    console.warn(`⚠️  Routes directory not found at: ${routesPath}. Creating it...`);
    
    // Create routes directory if it doesn't exist
    try {
      fs.mkdirSync(routesPath, { recursive: true });
      console.log(`✅ Created routes directory at: ${routesPath}`);
      
      // Create a sample route file
      const sampleRoute = `
const express = require('express');
const router = express.Router();

router.get('/', (req, res) => {
  res.json({ 
    message: 'Sample API route is working',
    timestamp: new Date().toISOString()
  });
});

module.exports = router;
      `;
      
      fs.writeFileSync(path.join(routesPath, 'sample.js'), sampleRoute.trim());
      console.log(`✅ Created sample route at: ${routesPath}/sample.js`);
    } catch (error) {
      console.error(`❌ Failed to create routes directory:`, error.message);
    }
  }
}

// Mount routes
mountRoutes();

// ========== IN-MEMORY STORAGE (FOR BACKWARD COMPATIBILITY) ==========
let users = [];
let messages = [];
const rooms = ['general', 'random', 'help', 'tech-support'];

// Log storage state periodically
setInterval(() => {
  console.log(`[Storage Stats] Users: ${users.length}, Messages: ${messages.length}, Rooms: ${rooms.length}, DB Connected: ${dbConnected}`);
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
// REAL HEALTH ENDPOINT: No auth, no DB queries, always responds
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

// API STATUS ENDPOINT
app.get('/api/status', (req, res) => {
  res.json({
    success: true,
    message: 'Backend API running',
    timestamp: new Date().toISOString(),
    environment: NODE_ENV,
    version: '1.0.0',
    server: 'MoodChat Backend',
    cors: 'enabled',
    database: dbConnected ? 'connected' : 'disconnected',
    origin: req.headers.origin || 'not specified',
    mountedRoutes: mountedRoutes.length > 0 ? mountedRoutes : 'No routes mounted from routes directory',
    endpoints: {
      health: '/api/health',
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

// REAL API HEALTH ENDPOINT: Critical fix - always available, no dependencies
app.get('/api/health', (req, res) => {
  res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
  res.status(200).json({
    status: 'ok',
    uptime: Math.floor(process.uptime()),
    timestamp: new Date().toISOString(),
    environment: NODE_ENV,
    database: dbConnected ? 'connected' : 'disconnected',
    service: 'moodchat-backend',
    version: '1.0.0'
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
    cors: 'ALLOWED',
    mountedRoutes: mountedRoutes,
    dbConnected: dbConnected
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

// ========== AUTHENTICATION ROUTES (LEGACY - KEPT FOR COMPATIBILITY) ==========
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
    
    // Use database if available
    if (dbConnected && sequelize && models && models.User) {
      try {
        const User = models.User;
        // Check if user already exists in database
        const existingUser = await User.findOne({ where: { email } });
        if (existingUser) {
          return res.status(400).json({
            success: false,
            message: 'User already exists',
            timestamp: new Date().toISOString()
          });
        }
        
        // Hash password
        const hashedPassword = await bcrypt.hash(password, 10);
        
        // Create user in database
        const user = await User.create({
          email,
          username,
          password: hashedPassword,
          avatar: `https://ui-avatars.com/api/?name=${encodeURIComponent(username)}&background=random&color=fff`
        });
        
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
        return res.status(201).json({
          success: true,
          message: 'User registered successfully in database',
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
      } catch (dbError) {
        console.error('Database registration error:', dbError);
        // Fall through to in-memory storage
      }
    }
    
    // Fallback to in-memory storage if database not available
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
      message: 'User registered successfully in memory',
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
    
    // Use database if available
    if (dbConnected && sequelize && models && models.User) {
      try {
        const User = models.User;
        
        let user;
        // Try email first, then username
        if (email.includes('@')) {
          user = await User.findOne({ where: { email } });
        } else {
          user = await User.findOne({ where: { username: email } });
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
        
        return res.json({
          success: true,
          message: 'Login successful (database)',
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
      } catch (dbError) {
        console.error('Database login error:', dbError);
        // Fall through to in-memory storage
      }
    }
    
    // Fallback to in-memory storage if database not available
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
      message: 'Login successful (memory)',
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
    // Try database first
    if (dbConnected && sequelize && models && models.User) {
      try {
        const User = models.User;
        User.findByPk(req.user.userId)
          .then(user => {
            if (!user) {
              return res.status(404).json({
                success: false,
                message: 'User not found in database',
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
          })
          .catch(dbError => {
            console.error('Database profile error:', dbError);
            // Fall through to in-memory
          });
      } catch (error) {
        // Fall through to in-memory
      }
    }
    
    // Fallback to in-memory
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

// ========== API CATCH-ALL HANDLER ==========
// CRITICAL FIX: Handle all unmatched /api/* routes with JSON 404
app.all('/api/*', (req, res) => {
  console.warn(`⚠️  Unhandled API route: ${req.method} ${req.path}`);
  res.status(404).json({
    success: false,
    message: `API endpoint ${req.method} ${req.path} not found`,
    timestamp: new Date().toISOString(),
    availableEndpoints: mountedRoutes.length > 0 ? mountedRoutes : [
      '/api/health',
      '/api/status',
      '/api/debug',
      '/api/register',
      '/api/login',
      '/api/logout',
      '/api/auth/register',
      '/api/auth/login',
      '/api/auth/me',
      '/api/auth/profile',
      '/api/chat/rooms',
      '/api/chat/messages/:room',
      '/api/chat/messages',
      '/api/stats',
      '/api/user/search',
      '/api/test-json'
    ],
    suggestion: 'Check that the route is properly defined in the routes directory'
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
// 404 handler for non-API routes
app.use((req, res) => {
  if (req.path.startsWith('/api/')) {
    // Already handled by the /api/* catch-all above
    return;
  }
  
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
        '/api/user/search'
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
  console.error('🚨 Global error handler:', {
    message: err.message,
    stack: err.stack,
    path: req.path,
    method: req.method,
    body: req.body
  });
  
  // Handle CORS errors
  if (err.message.includes('CORS')) {
    return res.status(403).json({
      success: false,
      message: 'CORS error: ' + err.message,
      timestamp: new Date().toISOString(),
      allowedOrigins: NODE_ENV === 'development' ? 'ALL (*)' : 'restricted'
    });
  }
  
  // Handle JWT errors
  if (err.name === 'JsonWebTokenError') {
    return res.status(401).json({
      success: false,
      message: 'Invalid token',
      timestamp: new Date().toISOString()
    });
  }
  
  if (err.name === 'TokenExpiredError') {
    return res.status(401).json({
      success: false,
      message: 'Token expired',
      timestamp: new Date().toISOString()
    });
  }
  
  // Handle database errors
  if (err.name && err.name.includes('Sequelize')) {
    return res.status(500).json({
      success: false,
      message: 'Database error',
      error: NODE_ENV === 'development' ? err.message : undefined,
      timestamp: new Date().toISOString()
    });
  }
  
  // Handle bcrypt errors
  if (err.message.includes('bcrypt')) {
    return res.status(500).json({
      success: false,
      message: 'Password processing error',
      timestamp: new Date().toISOString()
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
    console.log(`│   🗄️  Database: ${dbConnected ? '✅ Connected' : '⚠️  Not Connected'}    `);
    console.log(`│   🔓 CORS:     ${NODE_ENV === 'development' ? 'ALLOW ALL ORIGINS' : 'RESTRICTED'}    `);
    console.log(`│   🛣️  Routes:   ${mountedRoutes.length} mounted           `);
    console.log(`│                                                          │`);
    console.log(`│   📊 Health:   http://localhost:${PORT}/api/health       ${PORT < 1000 ? ' ' : ''}`);
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
    if (mountedRoutes.length > 0) {
      console.log(`│   📋 Mounted API Routes:                                 │`);
      mountedRoutes.forEach(route => {
        console.log(`│   • ${route.padEnd(53)}│`);
      });
    } else {
      console.log(`│   ⚠️  No routes mounted from routes directory           │`);
    }
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
      
      // Close database connection if exists
      if (dbConnected && sequelize) {
        sequelize.close()
          .then(() => console.log('Database connection closed.'))
          .catch(err => console.error('Error closing database:', err.message));
      }
      
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
    console.error('🚨 Uncaught Exception:', error);
    // Don't exit immediately in development
    if (NODE_ENV === 'production') {
      shutdown('UNCAUGHT_EXCEPTION');
    }
  });

  process.on('unhandledRejection', (reason, promise) => {
    console.error('🚨 Unhandled Rejection at:', promise, 'reason:', reason);
  });

  server.on('error', (error) => {
    if (error.code === 'EADDRINUSE') {
      console.error(`❌ Port ${PORT} is already in use.`);
      console.error(`   Try: kill -9 $(lsof -t -i:${PORT}) or use a different port`);
      process.exit(1);
    } else {
      console.error('❌ Server error:', error);
      process.exit(1);
    }
  });

  return server;
};

// Start the server
if (require.main === module) {
  startServer();
}

module.exports = app;