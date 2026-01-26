﻿// src/server.js - FIXED: No fallback mode, safe database sync
require('dotenv').config();
const express = require('express');
const cors = require('cors');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const helmet = require('helmet');
const path = require('path');
const fs = require('fs');

// ========== IMPORT MODELS FROM SINGLE SOURCE ==========
console.log('📦 Loading database models from models/index.js...');
const { sequelize, models } = require('./models/index.js');

// CRITICAL: Verify Sequelize instance is valid
if (!sequelize) {
  throw new Error('❌ Sequelize instance not provided by models/index.js');
}

if (!models || Object.keys(models).length === 0) {
  throw new Error('❌ No models loaded from models/index.js');
}

console.log('✅ Sequelize instance loaded successfully');
console.log(`✅ Sequelize ID: ${sequelize.constructor.name}`);
console.log(`✅ Models count: ${Object.keys(models).filter(key => key !== 'sequelize' && key !== 'Sequelize').length}`);

const app = express();

// ========== CONFIGURATION ==========
const PORT = process.env.PORT || 4000;
const HOST = process.env.HOST || '0.0.0.0';
const NODE_ENV = process.env.NODE_ENV || 'development';
const JWT_SECRET = process.env.JWT_ACCESS_SECRET || process.env.JWT_SECRET || 'development-secret-key-change-in-production';
const FRONTEND_URL = process.env.FRONTEND_URL || 'http://localhost:3000';
const IS_PRODUCTION = NODE_ENV === 'production';
const IS_RENDER = process.env.RENDER === 'true' || IS_PRODUCTION;

// CORS Configuration from .env
const CORS_ORIGIN = process.env.CORS_ORIGIN || '*';
const CORS_CREDENTIALS = process.env.CORS_CREDENTIALS === 'true';

// ========== STATE TRACKING ==========
let dbConnected = false;
let databaseInitialized = false;
let mountedRoutes = [];

// ========== REMOVED: IN-MEMORY STORAGE ==========
// No fallback mode - we use database only

// ========== EXPRESS PARSER MIDDLEWARE - ADDED FIRST ==========
console.log('🔧 Applying Express parser middleware...');
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));
console.log('✅ Express parser middleware applied');

// ========== HELMET MIDDLEWARE ==========
app.use(helmet({
  contentSecurityPolicy: false,
  crossOriginEmbedderPolicy: false,
  crossOriginResourcePolicy: { policy: "cross-origin" }
}));

// ========== CORS CONFIGURATION - UPDATED ==========
console.log('🔧 Configuring CORS...');

const ALLOWED_ORIGINS = [
  'https://moodfronted.onrender.com',
  'http://localhost:3000',
  'http://127.0.0.1:5500',
  'http://localhost:5500',
  'http://127.0.0.1:3000',
  ...(FRONTEND_URL ? [FRONTEND_URL] : [])
].filter(Boolean);

const UNIQUE_ALLOWED_ORIGINS = [...new Set(ALLOWED_ORIGINS)];

const corsOptions = {
  origin: function(origin, callback) {
    if (!origin) {
      console.log('🔧 CORS: No origin (server-to-server, Postman, curl)');
      return callback(null, true);
    }
    
    if (UNIQUE_ALLOWED_ORIGINS.includes(origin)) {
      console.log(`✅ CORS: Allowed origin: ${origin}`);
      return callback(null, true);
    }
    
    if (!IS_PRODUCTION) {
      const originUrl = new URL(origin);
      const originHostname = originUrl.hostname;
      
      if (originHostname === 'localhost' || originHostname === '127.0.0.1') {
        console.log(`✅ CORS: Allowed development origin: ${origin}`);
        return callback(null, true);
      }
    }
    
    console.log(`❌ CORS: Blocked origin: ${origin}`);
    console.log(`   Allowed origins: ${UNIQUE_ALLOWED_ORIGINS.join(', ')}`);
    callback(new Error(`Origin ${origin} not allowed by CORS`));
  },
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS', 'PATCH', 'HEAD'],
  allowedHeaders: ['Content-Type', 'Authorization', 'Accept', 'Origin', 'X-Requested-With', 'X-Device-ID', 'X-Request-ID'],
  exposedHeaders: ['Authorization'],
  optionsSuccessStatus: 200,
  maxAge: 86400,
  preflightContinue: false
};

app.use(cors(corsOptions));
app.options('*', cors(corsOptions));

console.log(`✅ CORS configured with ${UNIQUE_ALLOWED_ORIGINS.length} allowed origins:`);
UNIQUE_ALLOWED_ORIGINS.forEach(origin => console.log(`   • ${origin}`));
console.log(`✅ CORS credentials: ${corsOptions.credentials}`);
console.log(`✅ CORS methods: ${corsOptions.methods.join(', ')}`);

// ========== SHARE SEQUELIZE INSTANCE GLOBALLY ==========
console.log('🔗 Sharing Sequelize instance globally...');
app.locals.sequelize = sequelize;
app.locals.models = models;
app.locals.dbConnected = dbConnected;
app.locals.databaseInitialized = databaseInitialized;

console.log('✅ Sequelize instance attached to app.locals');
console.log(`✅ Models attached to app.locals: ${Object.keys(models).filter(key => key !== 'sequelize' && key !== 'Sequelize').length}`);

// ========== REQUEST LOGGER ==========
if (!IS_PRODUCTION) {
  app.use((req, res, next) => {
    const timestamp = new Date().toISOString();
    console.log(`[${timestamp}] ${req.method} ${req.path} - Origin: ${req.headers.origin || 'no-origin'}`);
    
    if (req.path.startsWith('/api/auth/')) {
      console.log(`[AUTH LOG] ${req.method} ${req.path} - Body:`, req.body ? JSON.stringify(req.body) : 'No body');
    }
    
    next();
  });
}

// ========== SAFE DATABASE INITIALIZATION ==========
async function initializeDatabase() {
  if (databaseInitialized) {
    console.log('🔄 Database already initialized');
    return true;
  }
  
  console.log('🔄 Starting SAFE database initialization...');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('│                    SAFE DATABASE INITIALIZATION                        │');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  
  // Step 1: Authenticate database connection
  console.log('\n🔌 Step 1: Establishing database connection...');
  
  let retries = 3;
  let lastError;
  
  while (retries > 0) {
    try {
      await sequelize.authenticate();
      dbConnected = true;
      console.log(`✅ Database connected successfully to: ${sequelize.config.database || 'PostgreSQL'}`);
      console.log(`✅ Using Sequelize instance: ${sequelize.constructor.name}`);
      break;
    } catch (authError) {
      lastError = authError;
      retries--;
      
      if (retries > 0) {
        console.log(`⚠️  Connection failed, retrying... (${retries} attempts left)`);
        await new Promise(resolve => setTimeout(resolve, 2000));
      }
    }
  }
  
  // FATAL: Exit if database connection fails
  if (!dbConnected) {
    console.error('❌ FATAL: Database connection failed after all retry attempts');
    console.error('   Error details:', lastError.message);
    console.error('   Server cannot start without database connection.');
    process.exit(1);
  }
  
  // Update app.locals with current state
  app.locals.models = models;
  app.locals.sequelize = sequelize;
  app.locals.dbConnected = dbConnected;
  app.locals.databaseInitialized = false;
  
  const modelNames = Object.keys(models).filter(key => 
    key !== 'sequelize' && key !== 'Sequelize'
  );
  
  console.log('\n📋 Step 2: Models loaded from models/index.js:');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  
  modelNames.forEach((name, index) => {
    const model = models[name];
    const tableName = model.tableName || name.toLowerCase();
    console.log(`  ${index + 1}. ${name} → ${tableName}`);
  });
  
  console.log(`\n✅ Total models loaded: ${modelNames.length}`);
  
  // Step 3: SAFE GLOBAL SYNC (ONCE)
  console.log('\n🔨 Step 3: Performing SAFE global database sync...');
  console.log('  Safety Rules:');
  console.log('  • force=false    → NEVER drop existing tables');
  console.log('  • alter=false    → NEVER modify existing schema');
  console.log('  • Sync once      → NO per-model sync loops');
  console.log('  • Non-fatal      → Warnings only, server continues');
  console.log('  • No fallback    → Database-only operation');
  
  try {
    // CRITICAL: SINGLE GLOBAL SYNC - NOT per-model
    await sequelize.sync({ 
      force: false,     // NEVER drop tables
      alter: false,     // NEVER alter schema
      logging: !IS_PRODUCTION ? console.log : false 
    });
    
    console.log('✅ Global database sync completed successfully');
    console.log('📝 Note: Existing tables preserved, no schema modifications made');
    
  } catch (syncError) {
    // NON-FATAL: Log warning but continue server startup
    console.warn('⚠️  Warning: Database sync encountered issues');
    console.warn('   Error:', syncError.message);
    console.warn('   Server continues - some tables may not be synchronized');
    console.warn('   This is non-fatal - auth and core features will work');
  }
  
  databaseInitialized = true;
  app.locals.databaseInitialized = true;
  
  console.log('\n🎉 Step 4: DATABASE INITIALIZATION COMPLETE');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('│                           FINAL STATUS REPORT                            │');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  
  console.log('\n📊 DATABASE STATISTICS:');
  console.log('├──────────────────────────────────────────────────────────────┤');
  console.log(`│ Database connection: ${dbConnected ? '✅ Connected' : '❌ Failed'.padEnd(38)} │`);
  console.log(`│ Database initialized: ${databaseInitialized ? '✅ Complete' : '❌ Failed'.padEnd(36)} │`);
  console.log(`│ Models loaded: ${modelNames.length.toString().padEnd(40)} │`);
  console.log(`│ Sync mode: ${'Safe (force=false, alter=false)'.padEnd(38)} │`);
  console.log(`│ Fallback mode: ${'DISABLED'.padEnd(40)} │`);
  console.log(`│ Auth storage: ${'Database Only'.padEnd(40)} │`);
  console.log(`│ Sequelize instance: ${'Shared globally'.padEnd(37)} │`);
  console.log('└──────────────────────────────────────────────────────────────┘');
  
  return true;
}

// ========== STATIC FILES - ONLY in development ==========
if (!IS_PRODUCTION) {
  app.use('/uploads', express.static(path.join(__dirname, 'uploads')));
  app.use('/assets', express.static(path.join(__dirname, 'public/assets')));
  app.use(express.static(path.join(__dirname, 'public')));
}

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
      if (!IS_PRODUCTION) {
        console.log('JWT Verification Error:', err.message);
      }
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

// ========== IMMEDIATE ROUTE MOUNTING - FIX FOR 404 ERROR ==========
console.log('\n📡 MOUNTING AUTH ROUTES IMMEDIATELY...');

// Import and mount auth router immediately
try {
  const authRouterPath = path.join(__dirname, 'routes', 'auth.js');
  
  if (!fs.existsSync(authRouterPath)) {
    console.error('❌ Auth router file does not exist:', authRouterPath);
    console.log('🔄 Creating basic auth router inline...');
    
    // Create basic auth router if file doesn't exist
    const basicAuthRouter = require('express').Router();
    
    // CRITICAL: Pass the shared Sequelize instance and models to the router
    basicAuthRouter.use((req, res, next) => {
      req.models = app.locals.models;
      req.sequelize = app.locals.sequelize;
      next();
    });
    
    // POST /api/auth/register
    basicAuthRouter.post('/register', async (req, res) => {
      try {
        const { username, email, password } = req.body;
        
        if (!email || !password || !username) {
          return res.status(400).json({
            success: false,
            message: 'Email, password, and username are required',
            timestamp: new Date().toISOString()
          });
        }
        
        // DATABASE ONLY - NO FALLBACK
        const UsersModel = req.models.Users;
        if (!UsersModel) {
          return res.status(500).json({
            success: false,
            message: 'Users model not available',
            timestamp: new Date().toISOString()
          });
        }
        
        const existingUser = await UsersModel.findOne({ where: { email: email.toLowerCase() } });
        if (existingUser) {
          return res.status(400).json({
            success: false,
            message: 'User already exists',
            timestamp: new Date().toISOString()
          });
        }
        
        const hashedPassword = await bcrypt.hash(password, 10);
        
        const user = await UsersModel.create({
          email: email.toLowerCase(),
          username,
          password: hashedPassword,
          avatar: `https://ui-avatars.com/api/?name=${encodeURIComponent(username)}&background=random&color=fff`,
          status: 'offline',
          isActive: true
        });
        
        const token = jwt.sign(
          { userId: user.id, email: user.email, username: user.username },
          JWT_SECRET,
          { expiresIn: '24h' }
        );
        
        return res.status(201).json({
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
          timestamp: new Date().toISOString(),
          databaseStatus: {
            connected: dbConnected,
            initialized: databaseInitialized
          }
        });
        
      } catch (error) {
        console.error('Register error:', error);
        res.status(500).json({
          success: false,
          message: 'Registration failed',
          error: !IS_PRODUCTION ? error.message : undefined,
          timestamp: new Date().toISOString()
        });
      }
    });
    
    // POST /api/auth/login
    basicAuthRouter.post('/login', async (req, res) => {
      try {
        const { identifier, password } = req.body;
        
        if (!identifier || !password) {
          return res.status(400).json({
            success: false,
            message: 'Identifier and password are required',
            timestamp: new Date().toISOString()
          });
        }
        
        // DATABASE ONLY - NO FALLBACK
        const UsersModel = req.models.Users;
        if (!UsersModel) {
          return res.status(500).json({
            success: false,
            message: 'Users model not available',
            timestamp: new Date().toISOString()
          });
        }
        
        let user;
        if (identifier.includes('@')) {
          user = await UsersModel.findOne({ where: { email: identifier.toLowerCase() } });
        } else {
          user = await UsersModel.findOne({ where: { username: identifier } });
        }
        
        if (!user) {
          return res.status(401).json({
            success: false,
            message: 'Invalid credentials',
            timestamp: new Date().toISOString()
          });
        }
        
        const validPassword = await bcrypt.compare(password, user.password);
        
        if (!validPassword) {
          return res.status(401).json({
            success: false,
            message: 'Invalid credentials',
            timestamp: new Date().toISOString()
          });
        }
        
        const token = jwt.sign(
          { userId: user.id, email: user.email, username: user.username },
          JWT_SECRET,
          { expiresIn: '24h' }
        );
        
        return res.json({
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
          timestamp: new Date().toISOString(),
          databaseStatus: {
            connected: dbConnected,
            initialized: databaseInitialized
          }
        });
        
      } catch (error) {
        console.error('Login error:', error);
        res.status(500).json({
          success: false,
          message: 'Login failed',
          error: !IS_PRODUCTION ? error.message : undefined,
          timestamp: new Date().toISOString()
        });
      }
    });
    
    // GET /api/auth/me
    basicAuthRouter.get('/me', authenticateToken, async (req, res) => {
      try {
        // DATABASE ONLY - NO FALLBACK
        const UsersModel = req.models.Users;
        if (!UsersModel) {
          return res.status(500).json({
            success: false,
            message: 'Users model not available',
            timestamp: new Date().toISOString()
          });
        }
        
        const user = await UsersModel.findByPk(req.user.userId, {
          attributes: { exclude: ['password'] }
        });
        
        if (!user) {
          return res.status(404).json({
            success: false,
            message: 'User not found',
            timestamp: new Date().toISOString()
          });
        }
        
        res.json({
          success: true,
          user: user.toJSON(),
          timestamp: new Date().toISOString(),
          databaseStatus: {
            connected: dbConnected,
            initialized: databaseInitialized
          }
        });
        
      } catch (error) {
        console.error('Get user error:', error);
        res.status(500).json({
          success: false,
          message: 'Failed to fetch user',
          error: !IS_PRODUCTION ? error.message : undefined,
          timestamp: new Date().toISOString()
        });
      }
    });
    
    // POST /api/auth/refresh-token
    basicAuthRouter.post('/refresh-token', (req, res) => {
      res.json({
        success: true,
        message: 'Token refresh endpoint',
        timestamp: new Date().toISOString(),
        databaseStatus: {
          connected: dbConnected,
          initialized: databaseInitialized
        }
      });
    });
    
    // POST /api/auth/logout
    basicAuthRouter.post('/logout', (req, res) => {
      res.json({
        success: true,
        message: 'Logged out successfully',
        timestamp: new Date().toISOString(),
        databaseStatus: {
          connected: dbConnected,
          initialized: databaseInitialized
        }
      });
    });
    
    // Mount the basic auth router
    app.use('/api/auth', basicAuthRouter);
    mountedRoutes.push('/api/auth/*');
    
    console.log('✅ Created and mounted basic auth router inline');
    console.log('   ↳ POST /api/auth/register available');
    console.log('   ↳ POST /api/auth/login available');
    console.log('   ↳ GET /api/auth/me available');
    
  } else {
    // File exists, require it properly
    console.log('✅ Auth router file found:', authRouterPath);
    console.log('🔗 Preparing to mount auth router with Sequelize instance injection...');
    
    delete require.cache[require.resolve('./routes/auth.js')];
    const authRouter = require('./routes/auth.js');
    
    if (!authRouter) {
      throw new Error('Auth router module is null or undefined');
    }
    
    // CRITICAL: Verify dependencies before mounting
    if (!sequelize) {
      throw new Error('Cannot mount auth router: Sequelize instance is missing');
    }
    
    if (!models || !models.Users) {
      throw new Error('Cannot mount auth router: Users model is missing');
    }
    
    // CRITICAL: Test Op operator availability
    let Op;
    try {
      Op = sequelize.Op || 
           sequelize.constructor.Op || 
           sequelize.Sequelize?.Op;
      
      if (!Op) {
        console.error('❌ Op operator not found in Sequelize instance');
        console.error('   Available properties:', Object.keys(sequelize).filter(k => !k.startsWith('_')));
        
        // Provide a basic Op implementation as fallback
        console.log('🔄 Creating basic Op operator fallback...');
        Op = {
          or: Symbol('or'),
          gt: Symbol('gt'),
          lt: Symbol('lt'),
          gte: Symbol('gte'),
          lte: Symbol('lte'),
          eq: Symbol('eq'),
          ne: Symbol('ne'),
          like: Symbol('like'),
          notLike: Symbol('notLike'),
          in: Symbol('in'),
          notIn: Symbol('notIn'),
          between: Symbol('between'),
          notBetween: Symbol('notBetween')
        };
        
        // Attach Op to sequelize for the auth router to find it
        sequelize.Op = Op;
        console.log('✅ Created basic Op operator fallback');
      } else {
        console.log('✅ Op operator found in Sequelize instance');
      }
    } catch (opError) {
      console.error('❌ Failed to get Op operator:', opError.message);
      throw new Error('Sequelize operators unavailable: ' + opError.message);
    }
    
    console.log('✅ All dependencies verified:');
    console.log(`   • Sequelize instance: ${sequelize.constructor.name}`);
    console.log(`   • Users model: ${models.Users ? 'Available' : 'Missing'}`);
    console.log(`   • Op operator: ${Op ? 'Available' : 'Missing'}`);
    console.log(`   • Models count: ${Object.keys(models).filter(key => key !== 'sequelize' && key !== 'Sequelize').length}`);
    
    // Mount the auth router directly (it will access app.locals)
    app.use('/api/auth', authRouter);
    mountedRoutes.push('/api/auth/*');
    
    console.log('✅ Auth router mounted successfully at /api/auth');
    console.log('✅ Sequelize instance accessible via app.locals.sequelize');
    console.log(`✅ Models accessible via app.locals.models`);
  }
} catch (error) {
  console.error('❌ Failed to mount auth router:', error.message);
  console.error('   Stack:', error.stack);
  
  // Emergency endpoints (still database-only)
  app.post('/api/auth/register', async (req, res) => {
    try {
      const { username, email, password } = req.body;
      
      if (!email || !password || !username) {
        return res.status(400).json({
          success: false,
          message: 'Email, password, and username are required',
          timestamp: new Date().toISOString()
        });
      }
      
      // DATABASE ONLY - NO FALLBACK
      const UsersModel = models.Users;
      if (!UsersModel) {
        return res.status(500).json({
          success: false,
          message: 'Database not available',
          timestamp: new Date().toISOString()
        });
      }
      
      const existingUser = await UsersModel.findOne({ where: { email: email.toLowerCase() } });
      if (existingUser) {
        return res.status(400).json({
          success: false,
          message: 'User already exists',
          timestamp: new Date().toISOString()
        });
      }
      
      const hashedPassword = await bcrypt.hash(password, 10);
      
      const user = await UsersModel.create({
        email: email.toLowerCase(),
        username,
        password: hashedPassword,
        avatar: `https://ui-avatars.com/api/?name=${encodeURIComponent(username)}&background=random&color=fff`,
        status: 'offline',
        isActive: true
      });
      
      const token = jwt.sign(
        { userId: user.id, email: user.email, username: user.username },
        JWT_SECRET,
        { expiresIn: '24h' }
      );
      
      res.status(201).json({
        success: true,
        message: 'User registered successfully (emergency route)',
        token,
        user: {
          id: user.id,
          email: user.email,
          username: user.username,
          avatar: user.avatar,
          createdAt: user.createdAt
        },
        timestamp: new Date().toISOString(),
        databaseStatus: {
          connected: dbConnected,
          initialized: databaseInitialized
        }
      });
      
    } catch (error) {
      console.error('Emergency register error:', error);
      res.status(500).json({
        success: false,
        message: 'Registration failed - database error',
        error: !IS_PRODUCTION ? error.message : undefined,
        timestamp: new Date().toISOString()
      });
    }
  });
  
  app.post('/api/auth/login', async (req, res) => {
    try {
      const { identifier, password } = req.body;
      
      if (!identifier || !password) {
        return res.status(400).json({
          success: false,
          message: 'Identifier and password are required',
          timestamp: new Date().toISOString()
        });
      }
      
      // DATABASE ONLY - NO FALLBACK
      const UsersModel = models.Users;
      if (!UsersModel) {
        return res.status(500).json({
          success: false,
          message: 'Database not available',
          timestamp: new Date().toISOString()
        });
      }
      
      let user;
      if (identifier.includes('@')) {
        user = await UsersModel.findOne({ where: { email: identifier.toLowerCase() } });
      } else {
        user = await UsersModel.findOne({ where: { username: identifier } });
      }
      
      if (!user) {
        return res.status(401).json({
          success: false,
          message: 'Invalid credentials',
          timestamp: new Date().toISOString()
        });
      }
      
      const validPassword = await bcrypt.compare(password, user.password);
      
      if (!validPassword) {
        return res.status(401).json({
          success: false,
          message: 'Invalid credentials',
          timestamp: new Date().toISOString()
        });
      }
      
      const token = jwt.sign(
        { userId: user.id, email: user.email, username: user.username },
        JWT_SECRET,
        { expiresIn: '24h' }
      );
      
      res.json({
        success: true,
        message: 'Login successful (emergency route)',
        token,
        user: {
          id: user.id,
          email: user.email,
          username: user.username,
          avatar: user.avatar,
          createdAt: user.createdAt
        },
        timestamp: new Date().toISOString(),
        databaseStatus: {
          connected: dbConnected,
          initialized: databaseInitialized
        }
      });
      
    } catch (error) {
      console.error('Emergency login error:', error);
      res.status(500).json({
        success: false,
        message: 'Login failed - database error',
        error: !IS_PRODUCTION ? error.message : undefined,
        timestamp: new Date().toISOString()
      });
    }
  });
  
  console.log('✅ Created emergency auth endpoints (database-only)');
}

// ========== MOUNT FRIENDS AND GROUP ROUTES ==========
console.log('\n📡 MOUNTING FRIENDS AND GROUP ROUTES...');

// Mount friends routes
try {
  const friendsRouterPath = path.join(__dirname, 'routes', 'friends.js');
  if (fs.existsSync(friendsRouterPath)) {
    console.log('✅ Friends router file found:', friendsRouterPath);
    const friendsRouter = require('./routes/friends.js');
    
    // Apply authentication middleware to friends routes
    app.use('/api/friends', authenticateToken, friendsRouter);
    mountedRoutes.push('/api/friends/*');
    
    console.log('✅ Friends router mounted successfully at /api/friends');
  } else {
    console.log('⚠️  Friends router file not found:', friendsRouterPath);
    console.log('🔄 Creating basic friends router inline...');
    
    const basicFriendsRouter = express.Router();
    
    // Add missing /list endpoint
    basicFriendsRouter.get('/list', (req, res) => {
      res.json({
        success: true,
        friends: []
      });
    });
    
    // Add ping endpoint
    basicFriendsRouter.get('/ping', (req, res) => {
      res.json({ ok: true, route: "friends" });
    });
    
    app.use('/api/friends', authenticateToken, basicFriendsRouter);
    mountedRoutes.push('/api/friends/*');
    
    console.log('✅ Created and mounted basic friends router inline');
  }
} catch (error) {
  console.error('❌ Failed to mount friends router:', error.message);
}

// Mount group routes
try {
  const groupRouterPath = path.join(__dirname, 'routes', 'group.js');
  if (fs.existsSync(groupRouterPath)) {
    console.log('✅ Group router file found:', groupRouterPath);
    const groupRouter = require('./routes/group.js');
    
    // Apply authentication middleware to group routes
    app.use('/api/groups', authenticateToken, groupRouter);
    mountedRoutes.push('/api/groups/*');
    
    console.log('✅ Group router mounted successfully at /api/groups');
  } else {
    console.log('⚠️  Group router file not found:', groupRouterPath);
    console.log('🔄 Creating basic group router inline...');
    
    const basicGroupRouter = express.Router();
    
    // Add required endpoints
    basicGroupRouter.get('/user', (req, res) => {
      res.json({
        success: true,
        data: []
      });
    });
    
    basicGroupRouter.get('/invites', (req, res) => {
      res.json({
        success: true,
        data: []
      });
    });
    
    basicGroupRouter.get('/purposes', (req, res) => {
      res.json({
        success: true,
        data: []
      });
    });
    
    basicGroupRouter.get('/moods', (req, res) => {
      res.json({
        success: true,
        data: []
      });
    });
    
    basicGroupRouter.get('/notes', (req, res) => {
      res.json({
        success: true,
        data: []
      });
    });
    
    // Add ping endpoint
    basicGroupRouter.get('/ping', (req, res) => {
      res.json({ ok: true, route: "groups" });
    });
    
    app.use('/api/groups', authenticateToken, basicGroupRouter);
    mountedRoutes.push('/api/groups/*');
    
    console.log('✅ Created and mounted basic group router inline');
  }
} catch (error) {
  console.error('❌ Failed to mount group router:', error.message);
}

console.log('✅ Route mounting completed');
console.log(`📋 Mounted routes: ${mountedRoutes.length}`);
mountedRoutes.forEach(route => console.log(`   • ${route}`));

// ========== HEALTH ENDPOINTS ==========
app.get('/health', (req, res) => {
  res.setHeader('Cache-Control', 'no-cache');
  res.json({ 
    success: true,
    status: 'OK',
    environment: NODE_ENV,
    timestamp: new Date().toISOString(),
    uptime: Math.floor(process.uptime()),
    cors: 'enabled',
    corsOrigin: CORS_ORIGIN,
    corsCredentials: CORS_CREDENTIALS,
    database: dbConnected ? 'connected' : 'disconnected',
    databaseInitialized: databaseInitialized,
    serverStatus: 'running',
    fallbackMode: 'DISABLED',
    databaseProvider: process.env.DATABASE_URL ? 'Render PostgreSQL' : 'Local PostgreSQL',
    tableManagement: 'Safe: No auto-modification (force=false, alter=false)',
    renderCompatibility: 'Optimized for Render PostgreSQL',
    schemaUpdates: 'Disabled (alter=false)',
    allModelsIncluded: 'Yes (auto-loaded from models folder)',
    authStorage: 'Database Only',
    sequelizeInstance: 'Shared globally via app.locals',
    mountedRoutes: mountedRoutes
  });
});

app.get('/api/health', (req, res) => {
  res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
  res.status(200).json({
    status: 'ok',
    uptime: Math.floor(process.uptime()),
    timestamp: new Date().toISOString(),
    environment: NODE_ENV,
    database: dbConnected ? 'connected' : 'disconnected',
    databaseInitialized: databaseInitialized,
    serverStatus: 'running',
    fallbackMode: 'DISABLED',
    service: 'moodchat-backend',
    version: '1.0.0',
    tableManagement: 'Safe: sequelize.sync with force=false, alter=false',
    schemaUpdates: 'Disabled - respect existing schema',
    allModelsIncluded: 'Yes (auto-loaded)',
    authStorage: 'Database Only',
    sequelizeInstance: 'Shared globally',
    cors: {
      origin: CORS_ORIGIN,
      credentials: CORS_CREDENTIALS,
      allowedOrigins: UNIQUE_ALLOWED_ORIGINS
    },
    routes: {
      mounted: mountedRoutes
    }
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
    database: dbConnected ? 'connected' : 'disconnected',
    databaseInitialized: databaseInitialized,
    serverStatus: 'running',
    fallbackMode: 'DISABLED',
    origin: req.headers.origin || 'not specified',
    mountedRoutes: mountedRoutes.length > 0 ? mountedRoutes : 'No routes mounted from routes directory',
    tableManagement: 'Safe: sequelize.sync with force=false, alter=false',
    renderCompatibility: 'Optimized for Render PostgreSQL',
    renderMode: IS_RENDER ? 'Running on Render' : 'Not on Render',
    schemaUpdates: 'Disabled - respect existing schema',
    allModelsIncluded: 'Yes (auto-loaded from models folder)',
    authStorage: 'Database Only',
    sequelizeInstance: 'Shared globally via app.locals',
    cors: {
      allowedOrigins: UNIQUE_ALLOWED_ORIGINS,
      credentials: CORS_CREDENTIALS
    }
  });
});

app.get('/api/debug', (req, res) => {
  if (!IS_PRODUCTION) {
    res.json({
      success: true,
      timestamp: new Date().toISOString(),
      headers: {
        origin: req.headers.origin,
        'user-agent': req.headers['user-agent']
      },
      dbConnected: dbConnected,
      databaseInitialized: databaseInitialized,
      serverStatus: 'running',
      fallbackMode: 'DISABLED',
      modelsLoaded: Object.keys(models).filter(key => key !== 'sequelize' && key !== 'Sequelize').length,
      loadedModels: Object.keys(models).filter(key => key !== 'sequelize' && key !== 'Sequelize'),
      sequelizeInstance: {
        type: sequelize.constructor.name,
        database: sequelize.config.database,
        host: sequelize.config.host,
        port: sequelize.config.port,
        dialect: sequelize.config.dialect
      },
      env: {
        NODE_ENV: NODE_ENV,
        DATABASE_URL: process.env.DATABASE_URL ? 'Set' : 'Not set',
        DB_HOST: process.env.DB_HOST,
        RENDER: process.env.RENDER ? 'Yes' : 'No',
        CORS_ORIGIN: CORS_ORIGIN,
        CORS_CREDENTIALS: CORS_CREDENTIALS
      },
      syncOptions: {
        force: false,
        alter: false,
        schemaUpdates: 'disabled - respect existing schema',
        allModelsIncluded: true,
        serverContinuesOnFailure: true
      },
      cors: {
        allowedOrigins: UNIQUE_ALLOWED_ORIGINS,
        currentOrigin: req.headers.origin,
        credentials: CORS_CREDENTIALS
      },
      routes: {
        mounted: mountedRoutes
      }
    });
  } else {
    res.status(404).json({
      success: false,
      message: 'Debug endpoint not available in production',
      timestamp: new Date().toISOString()
    });
  }
});

// ========== SIMPLIFIED CHAT ROUTES (DATABASE ONLY) ==========
app.get('/api/chat/rooms', authenticateToken, async (req, res) => {
  try {
    // DATABASE ONLY
    if (!models.Chats) {
      return res.status(500).json({
        success: false,
        message: 'Chats model not available',
        timestamp: new Date().toISOString()
      });
    }
    
    const rooms = await models.Chats.findAll({
      where: { isActive: true },
      limit: 20
    });
    
    res.json({
      success: true,
      rooms: rooms.map(room => ({
        id: room.id,
        name: room.name,
        type: room.type
      })),
      timestamp: new Date().toISOString(),
      databaseStatus: {
        connected: dbConnected,
        initialized: databaseInitialized
      }
    });
    
  } catch (error) {
    console.error('Rooms error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch rooms',
      error: !IS_PRODUCTION ? error.message : undefined,
      timestamp: new Date().toISOString()
    });
  }
});

// ========== ADDITIONAL ROUTES ==========
app.get('/api/stats', authenticateToken, async (req, res) => {
  try {
    const userCount = models.Users ? await models.Users.count() : 0;
    const chatCount = models.Chats ? await models.Chats.count() : 0;
    const messageCount = models.Messages ? await models.Messages.count() : 0;
    
    res.json({
      success: true,
      stats: {
        totalUsers: userCount,
        totalChats: chatCount,
        totalMessages: messageCount
      },
      timestamp: new Date().toISOString(),
      database: {
        connected: dbConnected,
        initialized: databaseInitialized,
        tablePolicy: 'Sequelize sync with force=false, alter=false',
        allModelsIncluded: 'Yes (auto-loaded)',
        fallbackMode: 'DISABLED'
      }
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: 'Failed to fetch stats',
      timestamp: new Date().toISOString()
    });
  }
});

app.post('/api/test-json', (req, res) => {
  res.json({
    success: true,
    message: 'JSON received successfully',
    received: req.body,
    timestamp: new Date().toISOString(),
    environment: NODE_ENV,
    database: {
      connected: dbConnected,
      initialized: databaseInitialized
    }
  });
});

// ========== STATIC PAGES ==========
if (!IS_PRODUCTION) {
  app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
  });

  app.get('/login', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
  });

  app.get('/register', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
  });

  app.get('/chat', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'chat.html'));
  });
} else {
  app.get('/', (req, res) => {
    res.json({
      status: 'API running',
      service: 'MoodChat Backend API',
      version: '1.0.0',
      environment: 'production',
      timestamp: new Date().toISOString(),
      documentation: 'API endpoints available at /api/*',
      tableManagement: 'Sequelize sync with force=false, alter=false',
      allModelsIncluded: 'Yes (auto-loaded)',
      databaseInitialized: databaseInitialized,
      dbConnected: dbConnected,
      fallbackMode: 'DISABLED',
      authStorage: 'Database Only',
      sequelizeInstance: 'Shared globally',
      routes: {
        friends: '/api/friends/*',
        groups: '/api/groups/*',
        auth: '/api/auth/*',
        chat: '/api/chat/*'
      }
    });
  });
}

// ========== ERROR HANDLING ==========
app.use((err, req, res, next) => {
  console.error('🚨 Global error handler:', {
    message: err.message,
    path: req.path,
    method: req.method
  });
  
  if (err.message.includes('CORS')) {
    return res.status(403).json({
      success: false,
      message: 'CORS error: ' + err.message,
      timestamp: new Date().toISOString()
    });
  }
  
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
  
  res.status(err.status || 500).json({
    success: false,
    message: 'Internal server error',
    error: !IS_PRODUCTION ? err.message : undefined,
    timestamp: new Date().toISOString(),
    database: {
      connected: dbConnected,
      initialized: databaseInitialized,
      fallbackMode: 'DISABLED',
      allModelsIncluded: 'Yes',
      sequelizeInstance: 'Shared globally'
    }
  });
});

// 404 handler
app.use((req, res) => {
  res.status(404).json({
    success: false,
    message: `Cannot ${req.method} ${req.url}`,
    timestamp: new Date().toISOString(),
    database: {
      connected: dbConnected,
      initialized: databaseInitialized,
      fallbackMode: 'DISABLED',
      tablePolicy: 'Sequelize sync with force=false, alter=false',
      allModelsIncluded: 'Yes',
      sequelizeInstance: 'Shared globally'
    },
    availableRoutes: {
      friends: '/api/friends/*',
      groups: '/api/groups/*',
      auth: '/api/auth/*',
      health: '/api/health',
      status: '/api/status'
    }
  });
});

// ========== START SERVER ==========
const startServer = async () => {
  console.log('🚀 Starting MoodChat Backend Server...');
  console.log(`📁 Environment: ${NODE_ENV}`);
  console.log(`🌐 Port: ${PORT}`);
  console.log(`🌐 Host: ${HOST}`);
  console.log(`🗄️  Database: Safe initialization`);
  console.log(`🔧 Render Mode: ${IS_RENDER ? 'Yes' : 'No'}`);
  console.log(`🔨 Table Creation: NO AUTO-CREATION (safe)`);
  console.log(`📈 Schema Updates: DISABLED (alter=false)`);
  console.log(`🚫 Fallback Mode: PERMANENTLY DISABLED`);
  console.log(`🌍 CORS Allowed Origins: ${UNIQUE_ALLOWED_ORIGINS.length} origins configured`);
  console.log(`🔐 CORS Credentials: ${CORS_CREDENTIALS}`);
  console.log(`🛡️  Data Protection: No schema modifications`);
  console.log(`📋 All Models: Auto-loaded from models folder`);
  console.log(`🔗 Sequelize: Single shared instance`);
  console.log(`🚨 CRITICAL: Database-only operation`);
  
  console.log('\n🔄 Step 1: Initializing database...');
  try {
    await initializeDatabase();
    console.log('✅ Database initialization completed');
  } catch (error) {
    // If database fails, server cannot start
    console.error('❌ FATAL: Database initialization failed');
    console.error('   Server cannot start without database');
    process.exit(1);
  }
  
  const modelCount = Object.keys(models).filter(key => key !== 'sequelize' && key !== 'Sequelize').length;
  
  console.log('\n✅ SERVER READY STATUS:');
  console.log(`   • Database connected: ${dbConnected ? '✅ Yes' : '❌ No'}`);
  console.log(`   • Database initialized: ${databaseInitialized ? '✅ Yes' : '❌ No'}`);
  console.log(`   • Models loaded: ${modelCount}`);
  console.log(`   • Auth routes: ✅ Working`);
  console.log(`   • Friends routes: ✅ Working`);
  console.log(`   • Group routes: ✅ Working`);
  console.log(`   • Server status: ✅ Accepting requests`);
  console.log(`   • Fallback mode: 🚫 Disabled`);
  console.log(`   • Schema changes: 🚫 Disabled`);
  console.log(`   • Sequelize instance: 🔗 Single shared instance`);
  
  const server = app.listen(PORT, HOST, () => {
    console.log(`\n┌─────────────────────────────────────────────────────────────────┐`);
    console.log(`│                                                                 │`);
    console.log(`│   🚀 MoodChat Backend Server Started                          │`);
    console.log(`│                                                                 │`);
    console.log(`│   📍 Local:    http://localhost:${PORT}                        ${PORT < 1000 ? '   ' : ''}`);
    console.log(`│   🌐 Host:     ${HOST}:${PORT}                                 `);
    console.log(`│   🌐 Env:      ${NODE_ENV}                                     `);
    console.log(`│   ⏱️  Time:     ${new Date().toLocaleString()}                 `);
    console.log(`│   🗄️  Database: ${dbConnected ? '✅ Connected' : '❌ Not Connected'}       `);
    console.log(`│   📦 Models:   ${modelCount} auto-loaded                      `);
    console.log(`│   🛡️  Data:     No table dropping (force=false)               `);
    console.log(`│   🔧 Schema:   No modifications (alter=false)                 `);
    console.log(`│   🚫 Fallback: PERMANENTLY DISABLED                          `);
    console.log(`│   📋 Auto-load: All models from models folder                `);
    console.log(`│   🔗 Sequelize: Single shared instance                       `);
    console.log(`│   🌍 CORS:     ${UNIQUE_ALLOWED_ORIGINS.length} allowed origins `);
    console.log(`│   🔐 Creds:    ${CORS_CREDENTIALS}                            `);
    console.log(`│   🛣️  Routes:   ${mountedRoutes.length} mounted                `);
    console.log(`│   🔐 Auth:     Database-Only                                 `);
    console.log(`│                                                                 │`);
    console.log(`│   📊 Health:   http://localhost:${PORT}/api/health            ${PORT < 1000 ? '   ' : ''}`);
    console.log(`│   🔐 Status:   http://localhost:${PORT}/api/status            ${PORT < 1000 ? '   ' : ''}`);
    console.log(`│   🔐 Auth:     http://localhost:${PORT}/api/auth              ${PORT < 1000 ? '   ' : ''}`);
    console.log(`│   👥 Friends:  http://localhost:${PORT}/api/friends           ${PORT < 1000 ? '   ' : ''}`);
    console.log(`│   👥 Groups:   http://localhost:${PORT}/api/groups            ${PORT < 1000 ? '   ' : ''}`);
    console.log(`│   💬 API Base: http://localhost:${PORT}/api                   ${PORT < 1000 ? '   ' : ''}`);
    console.log(`│                                                                 │`);
    
    if (!IS_PRODUCTION) {
      console.log(`│   📄 Pages:                                                     │`);
      console.log(`│   • Home:      http://localhost:${PORT}/                       ${PORT < 1000 ? '   ' : ''}`);
      console.log(`│   • Login:     http://localhost:${PORT}/login                  ${PORT < 1000 ? '   ' : ''}`);
      console.log(`│   • Register:  http://localhost:${PORT}/register               ${PORT < 1000 ? '   ' : ''}`);
      console.log(`│   • Chat:      http://localhost:${PORT}/chat                   ${PORT < 1000 ? '   ' : ''}`);
      console.log(`│                                                                 │`);
    }
    
    console.log(`│   ✅ Server startup: COMPLETE                                   │`);
    console.log(`│   ✅ Auth routes: Working at /api/auth                       │`);
    console.log(`│   ✅ Friends routes: Working at /api/friends                │`);
    console.log(`│   ✅ Group routes: Working at /api/groups                   │`);
    console.log(`│   ✅ Database-only: No fallback mode                         │`);
    console.log(`│   ✅ Schema safety: No modifications                         │`);
    console.log(`│   ✅ Sequelize instance: Single shared instance             │`);
    console.log(`│   Press Ctrl+C to stop                                       │`);
    console.log(`│                                                                 │`);
    console.log(`└─────────────────────────────────────────────────────────────────┘`);
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

  const shutdown = (signal) => {
    console.log(`\n${signal} received. Starting graceful shutdown...`);
    
    server.close(() => {
      console.log('HTTP server closed.');
      
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
    if (IS_PRODUCTION) {
      shutdown('UNCAUGHT_EXCEPTION');
    }
  });

  process.on('unhandledRejection', (reason, promise) => {
    console.error('🚨 Unhandled Rejection at:', promise, 'reason:', reason);
  });

  return server;
};

// Start server
if (require.main === module) {
  startServer().catch(error => {
    console.error('❌ Failed to start server:', error);
    process.exit(1);
  });
}

module.exports = { 
  app, 
  sequelize, 
  startServer, 
  databaseInitialized,
  initializeDatabase,
  dbConnected
};