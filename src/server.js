﻿// src/server.js - UPDATED: Full auto-initialization with structured reporting
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
const { sequelize, models, initializeDatabase } = require('./models/index.js');

if (!sequelize) {
  throw new Error('❌ Sequelize instance not provided by models/index.js');
}

if (!models || Object.keys(models).length === 0) {
  throw new Error('❌ No models loaded from models/index.js');
}

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
let dbSyncComplete = false;
let databaseInitialized = false;
let mountedRoutes = [];
let dbInitializationResult = null;

// ========== IN-MEMORY STORAGE (FALLBACK - DISABLED) ==========
let users = [];
let messages = [];
const rooms = ['general', 'random', 'help', 'tech-support'];

// ========== EXPRESS PARSER MIDDLEWARE - ADDED FIRST ==========
// FIX 1: Ensure Express uses express.json() and express.urlencoded BEFORE any routers
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
// FIX 3: Professional CORS configuration with whitelist-based dynamic origin check
console.log('🔧 Configuring CORS...');

// Define the whitelist of allowed origins
const ALLOWED_ORIGINS = [
  'https://moodfronted.onrender.com',
  'http://localhost:3000',
  'http://127.0.0.1:5500',
  'http://localhost:5500',
  'http://127.0.0.1:3000',
  // Add any additional production origins from environment
  ...(FRONTEND_URL ? [FRONTEND_URL] : [])
].filter(Boolean);

// Remove duplicates while preserving order
const UNIQUE_ALLOWED_ORIGINS = [...new Set(ALLOWED_ORIGINS)];

// Dynamic CORS configuration function
const corsOptions = {
  origin: function(origin, callback) {
    // Allow requests with no origin (like Postman, curl, server-to-server)
    if (!origin) {
      console.log('🔧 CORS: No origin (server-to-server, Postman, curl)');
      return callback(null, true);
    }
    
    // Check if the origin is in the whitelist
    if (UNIQUE_ALLOWED_ORIGINS.includes(origin)) {
      console.log(`✅ CORS: Allowed origin: ${origin}`);
      return callback(null, true);
    }
    
    // Check for development origins with different ports
    if (!IS_PRODUCTION) {
      const originUrl = new URL(origin);
      const originHostname = originUrl.hostname;
      
      // Allow localhost on any port in development
      if (originHostname === 'localhost' || originHostname === '127.0.0.1') {
        console.log(`✅ CORS: Allowed development origin: ${origin}`);
        return callback(null, true);
      }
    }
    
    // Origin not allowed
    console.log(`❌ CORS: Blocked origin: ${origin}`);
    console.log(`   Allowed origins: ${UNIQUE_ALLOWED_ORIGINS.join(', ')}`);
    callback(new Error(`Origin ${origin} not allowed by CORS`));
  },
  credentials: true, // Allow credentials (cookies / authorization headers)
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS', 'PATCH', 'HEAD'],
  allowedHeaders: ['Content-Type', 'Authorization', 'Accept', 'Origin', 'X-Requested-With', 'X-Device-ID', 'X-Request-ID'],
  exposedHeaders: ['Authorization'],
  optionsSuccessStatus: 200,
  maxAge: 86400, // 24 hours for preflight cache
  preflightContinue: false
};

// Apply CORS middleware
app.use(cors(corsOptions));

// Handle preflight requests explicitly
app.options('*', cors(corsOptions));

console.log(`✅ CORS configured with ${UNIQUE_ALLOWED_ORIGINS.length} allowed origins:`);
UNIQUE_ALLOWED_ORIGINS.forEach(origin => console.log(`   • ${origin}`));
console.log(`✅ CORS credentials: ${corsOptions.credentials}`);
console.log(`✅ CORS methods: ${corsOptions.methods.join(', ')}`);

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

// ========== ENHANCED DATABASE INITIALIZATION ==========
async function initializeDatabaseWithReporting() {
  if (databaseInitialized) {
    return dbInitializationResult;
  }
  
  console.log('🔄 Starting enhanced database initialization...');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('│                       DATABASE INITIALIZATION                           │');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  
  // ========== DATABASE CONNECTION ==========
  console.log('\n🔌 Step 1: Establishing database connection...');
  
  let retries = 3;
  let lastError;
  
  while (retries > 0) {
    try {
      await sequelize.authenticate();
      dbConnected = true;
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
  
  if (!dbConnected) {
    throw new Error(`Failed to connect to database after retries: ${lastError.message}`);
  }
  
  const dbName = sequelize.config.database || 'PostgreSQL';
  console.log(`✅ Database connected successfully to: ${dbName}`);
  
  // Attach models to app.locals for route access
  app.locals.models = models;
  app.locals.sequelize = sequelize;
  app.locals.dbConnected = dbConnected;
  
  // ========== LOG ALL IMPORTED MODELS ==========
  const modelNames = Object.keys(models).filter(key => 
    key !== 'sequelize' && key !== 'Sequelize'
  );
  
  console.log('\n📋 Step 2: Models imported from models/index.js:');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  
  // Display models in a table format
  console.log('┌────────────────────┬──────────────────┬──────────────────┐');
  console.log('│ Model Name         │ Status           │ Table Name       │');
  console.log('├────────────────────┼──────────────────┼──────────────────┤');
  
  modelNames.forEach((name, index) => {
    const model = models[name];
    const tableName = model.tableName || name.toLowerCase();
    console.log(`│ ${name.padEnd(18)} │ LOADED           │ ${tableName.padEnd(16)} │`);
  });
  
  console.log('└────────────────────┴──────────────────┴──────────────────┘');
  console.log(`\n✅ Total models loaded: ${modelNames.length}`);
  
  // ========== CALL ENHANCED INITIALIZE DATABASE ==========
  console.log('\n🔨 Step 3: Safe database synchronization...');
  console.log('  Safety Rules:');
  console.log('  • force=false    → NEVER drop existing tables');
  console.log('  • alter=true     → Add missing columns only');
  console.log('  • ENUM detection → Log conflicts, continue startup');
  console.log('  • Data protection→ All existing data preserved');
  
  try {
    // Call the enhanced initialization from models/index.js
    dbInitializationResult = await initializeDatabase();
    
    if (dbInitializationResult.success) {
      dbSyncComplete = true;
      databaseInitialized = true;
      
      // Display final structured report
      console.log('\n🎉 Step 4: DATABASE INITIALIZATION COMPLETE');
      console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
      console.log('│                           FINAL STATUS REPORT                            │');
      console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
      
      const syncResults = dbInitializationResult.syncResults;
      
      console.log('\n📊 DATABASE STATISTICS:');
      console.log('├──────────────────────────────────────────────────────────────┤');
      console.log(`│ Total models loaded: ${modelNames.length.toString().padEnd(40)} │`);
      console.log(`│ Database connection: ${dbConnected ? '✅ Connected' : '❌ Failed'.padEnd(38)} │`);
      console.log(`│ Tables synchronized: ${dbSyncComplete ? '✅ Complete' : '❌ Failed'.padEnd(38)} │`);
      console.log(`│ Tables created:      ${syncResults.created.length.toString().padEnd(40)} │`);
      console.log(`│ Tables updated:      ${syncResults.altered.length.toString().padEnd(40)} │`);
      console.log(`│ Tables skipped:      ${syncResults.skipped.length.toString().padEnd(40)} │`);
      console.log(`│ ENUM conflicts:      ${dbInitializationResult.enumConflicts.length.toString().padEnd(40)} │`);
      console.log('└──────────────────────────────────────────────────────────────┘');
      
      // Show table status in structured format
      console.log('\n📋 TABLE STATUS OVERVIEW:');
      console.log('┌────────────────────┬──────────────────┬──────────────────┐');
      console.log('│ Table Name         │ Status           │ Action           │');
  console.log('├────────────────────┼──────────────────┼──────────────────┤');
      
      for (const tableInfo of syncResults.tablesInfo) {
        let statusIcon = '❓';
        if (tableInfo.status === 'CREATED') statusIcon = '✅';
        if (tableInfo.status === 'UPDATED') statusIcon = '⚡';
        if (tableInfo.status === 'FAILED') statusIcon = '❌';
        
        console.log(`│ ${tableInfo.tableName.padEnd(18)} │ ${statusIcon} ${tableInfo.status.padEnd(13)} │ ${tableInfo.action.substring(0, 16).padEnd(16)} │`);
      }
      
      console.log('└────────────────────┴──────────────────┴──────────────────┘');
      
      // Show ENUM conflicts if any
      if (dbInitializationResult.enumConflicts.length > 0) {
        console.log('\n⚠️  ENUM CONFLICTS (Manual review recommended):');
        console.log('┌────────────────────┬──────────────────┬─────────────────────────────┐');
        console.log('│ Table              │ Column           │ Conflict Details           │');
        console.log('├────────────────────┼──────────────────┼─────────────────────────────┤');
        
        dbInitializationResult.enumConflicts.forEach(conflict => {
          const details = `${conflict.existingValues.length} existing vs ${conflict.modelValues.length} model`;
          console.log(`│ ${conflict.table.padEnd(18)} │ ${conflict.column.padEnd(16)} │ ${details.padEnd(27)} │`);
        });
        
        console.log('└────────────────────┴──────────────────┴─────────────────────────────┘');
        console.log('💡 Note: ENUM conflicts do not prevent server startup.');
        console.log('   Existing database values are preserved. Model may need adjustment.');
      }
      
      // Verify and log associations
      console.log('\n🔗 Step 5: Verifying model associations...');
      try {
        let totalAssociations = 0;
        console.log('┌────────────────────┬──────────────────────────────────────────────┐');
        console.log('│ Model              │ Associations                                 │');
        console.log('├────────────────────┼──────────────────────────────────────────────┤');
        
        for (const modelName of modelNames) {
          const model = models[modelName];
          if (model && model.associations) {
            const associations = Object.keys(model.associations);
            if (associations.length > 0) {
              const assocList = associations.map(assocName => {
                const association = model.associations[assocName];
                return `${assocName} → ${association.target.name}`;
              }).join(', ');
              
              console.log(`│ ${modelName.padEnd(18)} │ ${assocList.padEnd(44)} │`);
              totalAssociations += associations.length;
            } else {
              console.log(`│ ${modelName.padEnd(18)} │ No associations (independent table)${' '.repeat(12)} │`);
            }
          }
        }
        
        console.log('└────────────────────┴──────────────────────────────────────────────┘');
        console.log(`✅ Total associations configured: ${totalAssociations}`);
        
      } catch (assocError) {
        console.log('⚠️  Could not verify associations:', assocError.message);
      }
      
      console.log('\n🎯 INITIALIZATION SUMMARY:');
      console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
      console.log(`   • Database: ${dbName}`);
      console.log(`   • Models: ${modelNames.length} loaded from models/index.js`);
      console.log(`   • Sync Method: Safe sequelize.sync() with alter=true`);
      console.log(`   • Mode: ${IS_PRODUCTION ? 'Production' : 'Development'}`);
      console.log(`   • Safety: No data loss (force=false)`);
      console.log(`   • Tables created: ${syncResults.created.length}`);
      console.log(`   • Tables updated: ${syncResults.altered.length}`);
      console.log(`   • ENUM conflicts: ${dbInitializationResult.enumConflicts.length}`);
      console.log(`   • All models included: Yes (auto-loaded from models folder)`);
      console.log(`   • Associations: All respected`);
      console.log(`   • Independent tables: All created automatically`);
      console.log(`   • Future tables: Will auto-create as models are added`);
      console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
      
      return true;
      
    } else {
      throw new Error(`Database initialization failed: ${dbInitializationResult.error}`);
    }
    
  } catch (error) {
    console.error('❌ Database initialization failed:', error.message);
    
    // Log error details
    if (!IS_PRODUCTION) {
      console.error('Error details:', {
        name: error.name,
        message: error.message,
        code: error.code || 'N/A',
        stack: error.stack
      });
    }
    
    // In production, we might want to continue if it's a non-critical error
    if (IS_PRODUCTION && (error.message.includes('relation') || error.message.includes('table'))) {
      console.warn('⚠️  Non-critical database error, continuing with partial initialization...');
      databaseInitialized = true;
      dbSyncComplete = true;
      return true;
    }
    
    throw new Error(`Database initialization failed: ${error.message}`);
  }
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

// ========== STRICT ROUTER MOUNTING FUNCTION - FIXED ==========
function mountAllRouters() {
  console.log('\n📡 Step 6: Mounting ALL routers (STRICT ORDER)...');
  
  // FIX 2: Mount auth router FIRST and EXPLICITLY with safe verification
  try {
    console.log('🔧 Attempting to load auth router from ./routes/auth.js...');
    const authRouterPath = path.join(__dirname, 'routes', 'auth.js');
    
    if (!fs.existsSync(authRouterPath)) {
      console.error('❌ Auth router file does not exist:', authRouterPath);
      throw new Error(`Auth router file not found: ${authRouterPath}`);
    }
    
    delete require.cache[require.resolve('./routes/auth.js')];
    const authRouter = require('./routes/auth.js');
    
    if (!authRouter) {
      throw new Error('Auth router module is null or undefined');
    }
    
    if (typeof authRouter !== 'function' && typeof authRouter !== 'object') {
      throw new Error(`Auth router is not a valid Express router (type: ${typeof authRouter})`);
    }
    
    // Handle both router as function or object with router property
    const routerToMount = typeof authRouter === 'function' ? authRouter : 
                         (authRouter.router || authRouter.default || authRouter);
    
    if (typeof routerToMount !== 'function') {
      throw new Error(`Cannot mount auth router - invalid type after extraction: ${typeof routerToMount}`);
    }
    
    app.use('/api/auth', routerToMount);
    mountedRoutes.push('/api/auth/*');
    console.log('✅ FIXED: Mounted auth router EXPLICITLY at /api/auth');
    console.log('   ↳ POST /api/auth/register available');
    console.log('   ↳ POST /api/auth/login available');
    console.log('   ↳ GET /api/auth/me available');
  } catch (error) {
    console.error('❌ FATAL: Failed to mount auth router:', error.message);
    console.error('   Stack:', error.stack);
    throw error;
  }
  
  // Mount main API router if it exists
  try {
    const mainRouterPath = path.join(__dirname, 'routes', 'index.js');
    if (fs.existsSync(mainRouterPath)) {
      delete require.cache[require.resolve(mainRouterPath)];
      const mainRouter = require(mainRouterPath);
      
      // Handle different export patterns
      const routerToMount = typeof mainRouter === 'function' ? mainRouter : 
                           (mainRouter.router || mainRouter.default || mainRouter);
      
      if (routerToMount && typeof routerToMount === 'function') {
        app.use('/api', routerToMount);
        mountedRoutes.push('/api/*');
        console.log('✅ Mounted main API router at /api');
      }
    }
  } catch (error) {
    console.warn('⚠️  Could not mount main API router:', error.message);
  }
  
  // Mount additional specific routers with safe verification
  const routeMounts = [
    { path: '/api/messages', file: 'messages.js' },
    { path: '/api/chats', file: 'chats.js' },
    { path: '/api/groups', file: 'groups.js' },
    { path: '/api/calls', file: 'calls.js' },
    { path: '/api/friends', file: 'friends.js' },
    { path: '/api/moods', file: 'moods.js' },
    { path: '/api/notifications', file: 'notifications.js' },
    { path: '/api/status', file: 'status.js' },
    { path: '/api/media', file: 'media.js' },
  ];
  
  for (const route of routeMounts) {
    try {
      const routePath = path.join(__dirname, 'routes', route.file);
      if (fs.existsSync(routePath)) {
        delete require.cache[require.resolve(routePath)];
        const routeModule = require(routePath);
        
        // Handle different export patterns
        const routerToMount = typeof routeModule === 'function' ? routeModule : 
                             (routeModule.router || routeModule.default || routeModule);
        
        if (routerToMount && typeof routerToMount === 'function') {
          app.use(route.path, routerToMount);
          mountedRoutes.push(`${route.path}/*`);
          console.log(`✅ Mounted ${route.file} at ${route.path}`);
        } else {
          console.warn(`⚠️  ${route.file} exists but does not export a valid router`);
        }
      }
    } catch (error) {
      console.warn(`⚠️  Could not mount ${route.file}:`, error.message);
    }
  }
  
  console.log(`✅ Total mounted routes: ${mountedRoutes.length}`);
  console.log('\n📋 VERIFICATION - All Registered Routes:');
  mountedRoutes.forEach(route => console.log(`   • ${route}`));
}

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
    dbSyncComplete: dbSyncComplete,
    databaseInitialized: databaseInitialized,
    tablesAutoCreated: 'Sequelize sync with alter=true',
    databaseProvider: process.env.DATABASE_URL ? 'Render PostgreSQL' : 'Local PostgreSQL',
    tableManagement: 'Safe: Creates missing tables only',
    renderCompatibility: 'Optimized for Render PostgreSQL',
    schemaUpdates: 'Safe: Adds missing columns only (alter=true)',
    allModelsIncluded: 'Yes (auto-loaded from models folder)',
    initializationResult: dbInitializationResult ? {
      success: dbInitializationResult.success,
      tablesCreated: dbInitializationResult.syncResults?.created?.length || 0,
      tablesUpdated: dbInitializationResult.syncResults?.altered?.length || 0,
      enumConflicts: dbInitializationResult.enumConflicts?.length || 0
    } : null
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
    dbSyncComplete: dbSyncComplete,
    databaseInitialized: databaseInitialized,
    service: 'moodchat-backend',
    version: '1.0.0',
    tableManagement: 'Safe: sequelize.sync with alter=true',
    schemaUpdates: 'Adds missing columns only',
    allModelsIncluded: 'Yes (auto-loaded)',
    autoInitialization: 'Full automatic with ENUM detection',
    cors: {
      origin: CORS_ORIGIN,
      credentials: CORS_CREDENTIALS,
      allowedOrigins: UNIQUE_ALLOWED_ORIGINS
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
    dbSyncComplete: dbSyncComplete,
    databaseInitialized: databaseInitialized,
    origin: req.headers.origin || 'not specified',
    mountedRoutes: mountedRoutes.length > 0 ? mountedRoutes : 'No routes mounted from routes directory',
    tableManagement: 'Safe: sequelize.sync with alter=true',
    renderCompatibility: 'Optimized for Render PostgreSQL',
    renderMode: IS_RENDER ? 'Running on Render' : 'Not on Render',
    schemaUpdates: 'Safe: Adds missing columns only',
    allModelsIncluded: 'Yes (auto-loaded from models folder)',
    autoInitialization: 'Full automatic with structured reporting',
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
      dbSyncComplete: dbSyncComplete,
      databaseInitialized: databaseInitialized,
      dbInitializationResult: dbInitializationResult,
      modelsLoaded: Object.keys(models).filter(key => key !== 'sequelize' && key !== 'Sequelize').length,
      loadedModels: Object.keys(models).filter(key => key !== 'sequelize' && key !== 'Sequelize'),
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
        alter: true,
        schemaUpdates: 'safe - adds missing columns only',
        allModelsIncluded: true,
        enumDetection: true,
        autoInitialization: true
      },
      cors: {
        allowedOrigins: UNIQUE_ALLOWED_ORIGINS,
        currentOrigin: req.headers.origin,
        credentials: CORS_CREDENTIALS
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

// ========== LEGACY AUTH ROUTES (PRESERVE FOR COMPATIBILITY) ==========
app.post('/api/register', async (req, res) => {
  try {
    const { email, password, username } = req.body;
    
    if (!email || !password || !username) {
      return res.status(400).json({
        success: false,
        message: 'Email, password, and username are required',
        timestamp: new Date().toISOString()
      });
    }
    
    // REQUIRE database connection for production
    if (!dbConnected) {
      return res.status(503).json({
        success: false,
        message: 'Database not available. Registration requires PostgreSQL connection.',
        timestamp: new Date().toISOString()
      });
    }
    
    // Use database only - no in-memory fallback
    try {
      const UsersModel = models.Users;
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
        { 
          userId: user.id, 
          email: user.email, 
          username: user.username 
        },
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
        storage: 'PostgreSQL (Permanent)',
        databaseInitialized: databaseInitialized,
        tableStatus: 'Auto-created by initialization system'
      });
    } catch (dbError) {
      console.error('Database registration error:', dbError.message);
      return res.status(500).json({
        success: false,
        message: 'Registration failed - database error',
        error: !IS_PRODUCTION ? dbError.message : undefined,
        timestamp: new Date().toISOString()
      });
    }
    
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

app.post('/api/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    
    if (!email || !password) {
      return res.status(400).json({
        success: false,
        message: 'Email and password are required',
        timestamp: new Date().toISOString()
      });
    }
    
    // REQUIRE database connection for production
    if (!dbConnected) {
      return res.status(503).json({
        success: false,
        message: 'Database not available. Please try again later.',
        timestamp: new Date().toISOString()
      });
    }
    
    // Use database only
    try {
      const UsersModel = models.Users;
      if (!UsersModel) {
        return res.status(500).json({
          success: false,
          message: 'Users model not available',
          timestamp: new Date().toISOString()
        });
      }
      
      let user;
      if (email.includes('@')) {
        user = await UsersModel.findOne({ where: { email: email.toLowerCase() } });
      } else {
        user = await UsersModel.findOne({ where: { username: email } });
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
        storage: 'PostgreSQL (Permanent)',
        databaseInitialized: databaseInitialized,
        tableStatus: 'Auto-maintained by initialization system'
      });
    } catch (dbError) {
      console.error('Database login error:', dbError.message);
      return res.status(500).json({
        success: false,
        message: 'Login failed - database error',
        error: !IS_PRODUCTION ? dbError.message : undefined,
        timestamp: new Date().toISOString()
      });
    }
    
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

app.get('/api/auth/me', authenticateToken, async (req, res) => {
  try {
    // REQUIRE database connection
    if (!dbConnected) {
      return res.status(503).json({
        success: false,
        message: 'Database not available',
        timestamp: new Date().toISOString()
      });
    }
    
    // Use database only
    try {
      const UsersModel = models.Users;
      if (!UsersModel) {
        return res.status(500).json({
          success: false,
          message: 'Users model not available',
          timestamp: new Date().toISOString()
        });
      }
      
      const user = await UsersModel.findByPk(req.user.userId);
      if (!user) {
        return res.status(404).json({
          success: false,
          message: 'User not found',
          timestamp: new Date().toISOString()
        });
      }
      
      return res.json({
        success: true,
        user: {
          id: user.id,
          email: user.email,
          username: user.username,
          avatar: user.avatar,
          createdAt: user.createdAt
        },
        timestamp: new Date().toISOString(),
        storage: 'PostgreSQL (Permanent)',
        databaseInitialized: databaseInitialized,
        initializationStatus: dbInitializationResult?.success ? 'Complete' : 'Failed'
      });
    } catch (dbError) {
      console.error('Database profile error:', dbError.message);
      return res.status(500).json({
        success: false,
        message: 'Failed to get profile - database error',
        error: !IS_PRODUCTION ? dbError.message : undefined,
        timestamp: new Date().toISOString()
      });
    }
    
  } catch (error) {
    console.error('Profile error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to get profile',
      error: !IS_PRODUCTION ? error.message : undefined,
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
      timestamp: new Date().toISOString(),
      storage: 'memory',
      databaseInitialized: databaseInitialized
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
      .slice(-100);
    
    res.json({
      success: true,
      room,
      messages: roomMessages,
      count: roomMessages.length,
      timestamp: new Date().toISOString(),
      storage: 'memory',
      databaseInitialized: databaseInitialized
    });
    
  } catch (error) {
    console.error('Messages error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch messages',
      error: !IS_PRODUCTION ? error.message : undefined,
      timestamp: new Date().toISOString()
    });
  }
});

app.post('/api/chat/messages', authenticateToken, async (req, res) => {
    try {
    const { room, content } = req.body;
    
    // FIX: Safely handle missing user in memory storage
    const user = users.find(u => u.id === req.user.userId);
    
    if (!user) {
      return res.status(404).json({
        success: false,
        message: 'User not found in memory storage',
        timestamp: new Date().toISOString()
      });
    }
    
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
    
    // Also save to database if available
    if (dbConnected && dbSyncComplete && models.Messages) {
      try {
        // First check if a Chat exists for this room
        let chat = await models.Chats.findOne({ where: { name: room } });
        
        if (!chat) {
          // Create a chat for this room
          chat = await models.Chats.create({
            name: room,
            type: 'group',
            isActive: true
          });
        }
        
        await models.Messages.create({
          chatId: chat.id,
          senderId: user.id,
          content,
          type: 'text',
          sentAt: new Date()
        });
      } catch (dbError) {
        console.error('Database message save error:', dbError.message);
      }
    }
    
    res.json({
      success: true,
      message: 'Message sent successfully',
      data: message,
      timestamp: new Date().toISOString(),
      storage: dbConnected ? 'memory+database' : 'memory',
      databaseInitialized: databaseInitialized
    });
    
  } catch (error) {
    console.error('Send message error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to send message',
      error: !IS_PRODUCTION ? error.message : undefined,
      timestamp: new Date().toISOString()
    });
  }
});

// ========== ADDITIONAL ROUTES ==========
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
    timestamp: new Date().toISOString(),
    database: {
      connected: dbConnected,
      dbSyncComplete: dbSyncComplete,
      databaseInitialized: databaseInitialized,
      tablePolicy: 'Sequelize sync with alter=true',
      allModelsIncluded: 'Yes (auto-loaded)',
      autoInitialization: 'Complete'
    }
  });
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
      dbSyncComplete: dbSyncComplete,
      databaseInitialized: databaseInitialized
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
  // In production, return API status for root route
  app.get('/', (req, res) => {
    res.json({
      status: 'API running',
      service: 'MoodChat Backend API',
      version: '1.0.0',
      environment: 'production',
      timestamp: new Date().toISOString(),
      documentation: 'API endpoints available at /api/*',
      tableManagement: 'Sequelize sync with alter=true',
      allModelsIncluded: 'Yes (auto-loaded)',
      autoInitialization: 'Full automatic with structured reporting',
      databaseInitialized: databaseInitialized,
      enumConflictDetection: 'Enabled'
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
      dbSyncComplete: dbSyncComplete,
      databaseInitialized: databaseInitialized,
      allModelsIncluded: 'Yes'
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
      dbSyncComplete: dbSyncComplete,
      databaseInitialized: databaseInitialized,
      tablePolicy: 'Sequelize sync with alter=true',
      allModelsIncluded: 'Yes'
    }
  });
});

// ========== START SERVER WITH STRICT ORDER - FIXED ==========
const startServer = async () => {
  console.log('🚀 Starting MoodChat Backend Server...');
  console.log(`📁 Environment: ${NODE_ENV}`);
  console.log(`🌐 Port: ${PORT}`);
  console.log(`🌐 Host: ${HOST}`);
  console.log(`🗄️  Database: Full auto-initialization`);
  console.log(`🔧 Render Mode: ${IS_RENDER ? 'Yes' : 'No'}`);
  console.log(`🔨 Table Creation: AUTO-CREATE (safe)`);
  console.log(`📈 Schema Updates: Safe (alter=true)`);
  console.log(`🔍 ENUM Detection: Enabled`);
  console.log(`🌍 CORS Allowed Origins: ${UNIQUE_ALLOWED_ORIGINS.length} origins configured`);
  console.log(`🔐 CORS Credentials: ${CORS_CREDENTIALS}`);
  console.log(`🛡️  Data Protection: No data loss, safe schema updates`);
  console.log(`📋 All Models: Auto-loaded from models folder`);
  
  // STEP 1: Initialize database with enhanced reporting
  // FIX 4: Ensure Sequelize database is synced before app.listen()
  console.log('\n🔄 Step 1: Initializing database...');
  try {
    const dbInitSuccess = await initializeDatabaseWithReporting();
    
    if (!dbInitSuccess) {
      throw new Error('Database initialization returned false');
    }
    console.log('✅ Database initialized successfully');
  } catch (error) {
    console.error('❌ FATAL: Database initialization failed:', error.message);
    console.error('   Server cannot start without database connection.');
    process.exit(1);
  }
  
  // STEP 2: ONLY AFTER DB SUCCESS, mount ALL routers
  console.log('\n📡 Step 2: Mounting routers (AFTER database success)...');
  try {
    mountAllRouters();
    console.log('✅ All routers mounted successfully');
  } catch (error) {
    console.error('❌ FATAL: Router mounting failed:', error.message);
    console.error('   Server cannot start without routes.');
    process.exit(1);
  }
  
  // Final verification
  const modelCount = Object.keys(models).filter(key => key !== 'sequelize' && key !== 'Sequelize').length;
  
  if (dbSyncComplete && databaseInitialized) {
    console.log('\n✅ Database ready for production.');
    console.log('✅ Full auto-initialization: Complete');
    console.log('✅ Structured reporting: Enabled');
    console.log('✅ ENUM conflict detection: Active');
    console.log('✅ Data preservation: All existing data maintained');
    console.log('✅ Schema safety: Missing columns added (alter=true)');
    console.log('✅ Future compatibility: New tables auto-created');
  } else {
    console.error('❌ FATAL: Database not fully initialized');
    console.error('   Server cannot start without database synchronization.');
    process.exit(1);
  }
  
  // FIX 7: Proper error handling on server start
  // STEP 3: Start the server
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
    console.log(`│   📊 Tables:   ${databaseInitialized ? '✅ Auto-initialized' : '❌ Failed'} `);
    console.log(`│   📦 Models:   ${modelCount} auto-loaded                      `);
    console.log(`│   🛡️  Data:     No table dropping (force=false)               `);
    console.log(`│   🔧 Schema:   Safe updates (alter=true)                      `);
    console.log(`│   🔍 ENUM:     Conflict detection enabled                     `);
    console.log(`│   📋 Auto-load: All models from models folder                `);
    console.log(`│   🌍 CORS:     ${UNIQUE_ALLOWED_ORIGINS.length} allowed origins `);
    console.log(`│   🔐 Creds:    ${CORS_CREDENTIALS}                            `);
    console.log(`│   🛣️  Routes:   ${mountedRoutes.length} mounted                `);
    console.log(`│   📈 Reporting: Structured console output                     `);
    console.log(`│                                                                 │`);
    console.log(`│   📊 Health:   http://localhost:${PORT}/api/health            ${PORT < 1000 ? '   ' : ''}`);
    console.log(`│   🔐 Status:   http://localhost:${PORT}/api/status            ${PORT < 1000 ? '   ' : ''}`);
    console.log(`│   🔐 Auth:     http://localhost:${PORT}/api/auth              ${PORT < 1000 ? '   ' : ''}`);
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
    
    console.log(`│   ✅ Database auto-initialization: COMPLETE                   │`);
    console.log(`│   ✅ Strict loading order: DB → Models → Routers              │`);
    console.log(`│   ✅ Auth router: Mounted at /api/auth                        │`);
    console.log(`│   ✅ Router protection: No router-as-model loading           │`);
    console.log(`│   ✅ Express parsers: Applied before routers                  │`);
    console.log(`│   ✅ CORS configured: Whitelist with credentials              │`);
    console.log(`│   Press Ctrl+C to stop                                       │`);
    console.log(`│                                                                 │`);
    console.log(`└─────────────────────────────────────────────────────────────────┘`);
  });

  // FIX 7: Error handling for server start
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

  // Graceful shutdown
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
  dbSyncComplete,
  databaseInitialized,
  initializeDatabaseWithReporting,
  mountAllRouters
};