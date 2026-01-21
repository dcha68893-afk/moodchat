﻿// src/server.js - COMPLETE FRESH IMPLEMENTATION
require('dotenv').config();
const express = require('express');
const cors = require('cors');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const helmet = require('helmet');
const path = require('path');
const fs = require('fs');
const { Sequelize, DataTypes } = require('sequelize');

const app = express();

// ========== CONFIGURATION ==========
const PORT = process.env.PORT || 4000;
const NODE_ENV = process.env.NODE_ENV || 'development';
const JWT_SECRET = process.env.JWT_ACCESS_SECRET || process.env.JWT_SECRET || 'development-secret-key-change-in-production';
const FRONTEND_URL = process.env.FRONTEND_URL || 'http://localhost:3000';
const IS_PRODUCTION = NODE_ENV === 'production';
const IS_RENDER = process.env.RENDER === 'true' || IS_PRODUCTION;

// ========== DATABASE CONNECTION ==========
let sequelize;
let dbConnected = false;
let models = {};

// ========== IN-MEMORY STORAGE ==========
let users = [];
let messages = [];
const rooms = ['general', 'random', 'help', 'tech-support'];

// State tracking
let storageStatsLogged = false;
let databaseInitialized = false;
let tablesSynchronized = false;
let mountedRoutes = [];

// ========== DATABASE INITIALIZATION ==========
async function initializeDatabase() {
  if (databaseInitialized) {
    return dbConnected;
  }
  
  console.log('🔄 Initializing database...');
  
  try {
    // Create Sequelize instance
    if (process.env.DATABASE_URL) {
      console.log('🔌 Using DATABASE_URL from environment...');
      sequelize = new Sequelize(process.env.DATABASE_URL, {
        dialect: process.env.DB_DIALECT || 'postgres',
        logging: false,
        pool: {
          max: 10,
          min: 0,
          acquire: 30000,
          idle: 10000
        },
        dialectOptions: IS_PRODUCTION ? {
          ssl: {
            require: true,
            rejectUnauthorized: false
          }
        } : {},
        define: {
          freezeTableName: true,
          timestamps: true,
          underscored: true,
          paranoid: false
        }
      });
    } else {
      console.log('🔌 Using individual DB environment variables...');
      sequelize = new Sequelize(
        process.env.DB_NAME || 'denismoo',
        process.env.DB_USER || 'postgres',
        process.env.DB_PASSWORD || 'a8UIFwP8552hGbYI9x7O3Dp7gs3vb6TV',
        {
          host: process.env.DB_HOST || '127.0.0.1',
          port: process.env.DB_PORT || 5432,
          dialect: process.env.DB_DIALECT || 'postgres',
          logging: IS_PRODUCTION ? false : console.log,
          pool: {
            max: 10,
            min: 0,
            acquire: 30000,
            idle: 10000
          },
          dialectOptions: IS_PRODUCTION && process.env.DB_SSL === 'true' ? {
            ssl: {
              require: true,
              rejectUnauthorized: false
            }
          } : {},
          define: {
            freezeTableName: true,
            timestamps: true,
            underscored: true,
            paranoid: false
          }
        }
      );
    }
    
    // Test connection
    console.log('🔌 Testing database connection...');
    await sequelize.authenticate();
    dbConnected = true;
    console.log('✅ Database connection established.');
    
    // ========== CRITICAL: LOAD ALL MODELS FOR TABLE MANAGEMENT ==========
    console.log('📦 Loading all database models...');
    
    // Try to load the models index file which contains all models
    try {
      const modelsPath = path.join(__dirname, 'models', 'index.js');
      if (fs.existsSync(modelsPath)) {
        console.log('📦 Loading models from models/index.js...');
        const modelsModule = require(modelsPath);
        
        if (modelsModule && typeof modelsModule === 'object') {
          // Extract all models from the module
          models = modelsModule;
          
          // Remove sequelize and Sequelize from models object
          delete models.sequelize;
          delete models.Sequelize;
          
          console.log(`✅ Loaded ${Object.keys(models).length} models:`, Object.keys(models).join(', '));
        } else {
          console.warn('⚠️  models/index.js did not export models object, creating basic models...');
          createBasicModels();
        }
      } else {
        console.warn('⚠️  models/index.js not found, creating basic models...');
        createBasicModels();
      }
    } catch (error) {
      console.warn('⚠️ Could not load models from models/index.js:', error.message);
      console.log('🔄 Creating basic models...');
      createBasicModels();
    }
    
    function createBasicModels() {
      // Define basic User model
      models.User = sequelize.define('User', {
        id: {
          type: DataTypes.INTEGER,
          primaryKey: true,
          autoIncrement: true
        },
        email: {
          type: DataTypes.STRING,
          allowNull: false,
          unique: true,
          validate: {
            isEmail: true
          }
        },
        username: {
          type: DataTypes.STRING,
          allowNull: false,
          unique: true
        },
        password: {
          type: DataTypes.STRING,
          allowNull: false
        },
        avatar: {
          type: DataTypes.STRING,
          defaultValue: 'https://ui-avatars.com/api/?name=User&background=random&color=fff'
        },
        createdAt: {
          type: DataTypes.DATE,
          defaultValue: DataTypes.NOW
        },
        updatedAt: {
          type: DataTypes.DATE,
          defaultValue: DataTypes.NOW
        }
      }, {
        tableName: 'Users',
        timestamps: true
      });
      
      // Define basic Message model
      models.Message = sequelize.define('Message', {
        id: {
          type: DataTypes.INTEGER,
          primaryKey: true,
          autoIncrement: true
        },
        room: {
          type: DataTypes.STRING,
          allowNull: false
        },
        content: {
          type: DataTypes.TEXT,
          allowNull: false
        },
        sender_id: {
          type: DataTypes.INTEGER,
          allowNull: false
        },
        sender_username: {
          type: DataTypes.STRING,
          allowNull: false
        },
        sender_avatar: {
          type: DataTypes.STRING
        },
        createdAt: {
          type: DataTypes.DATE,
          defaultValue: DataTypes.NOW
        }
      }, {
        tableName: 'Messages',
        timestamps: true,
        updatedAt: false
      });
    }
    
    // Attach models to app.locals
    app.locals.models = models;
    app.locals.sequelize = sequelize;
    
    // ========== CRITICAL: SAFE TABLE MANAGEMENT FOR RENDER ==========
    console.log('🔄 Managing database tables for production...');
    
    // Define independent tables that can be auto-created
    const independentTables = ['Users', 'Tokens', 'Friends', 'UserStatus'];
    
    // Define FK-dependent tables that should ONLY be created via migrations
    const dependentTables = ['Messages', 'Groups', 'Profile', 'ReadReceipt', 
                            'TypingIndicator', 'Mood', 'SharedMood', 'Media', 
                            'GroupMembers', 'Calls', 'Chats', 'ChatParticipants',
                            'Notifications', 'Status'];
    
    // Step 1: Run migrations first if available (for FK-dependent tables)
    let migrationsRun = false;
    if (!IS_PRODUCTION) {
      try {
        const { execSync } = require('child_process');
        console.log('🔨 Attempting to run database migrations...');
        execSync('npx sequelize-cli db:migrate', { stdio: 'inherit' });
        migrationsRun = true;
        console.log('✅ Migrations completed (or already up to date).');
      } catch (migrateError) {
        console.log('ℹ️ No migrations run or migration system not available:', migrateError.message);
      }
    } else {
      console.log('ℹ️ Skipping migrations in production mode');
    }
    
    // Step 2: Safely create independent tables ONLY if they don't exist
    console.log('🔨 Creating independent tables if they do not exist...');
    
    for (const [modelName, model] of Object.entries(models)) {
      if (model && model.sync) {
        const tableName = model.tableName || modelName;
        
        // Skip if table name is plural or singular version of dependent tables
        const isDependentTable = dependentTables.includes(tableName) || 
                                dependentTables.some(dep => 
                                  dep.toLowerCase() === tableName.toLowerCase() ||
                                  (dep.endsWith('s') && dep.slice(0, -1).toLowerCase() === tableName.toLowerCase()) ||
                                  (!dep.endsWith('s') && `${dep}s`.toLowerCase() === tableName.toLowerCase())
                                );
        
        // Check if table exists first
        try {
          const tableExists = await sequelize.getQueryInterface().tableExists(tableName);
          
          if (!tableExists) {
            // Only create independent tables automatically
            if (independentTables.includes(tableName)) {
              console.log(`📊 Creating independent table: ${tableName}`);
              await model.sync({ force: false, alter: false });
              console.log(`✅ Created table: ${tableName}`);
            } else if (isDependentTable) {
              console.warn(`⚠️  Skipping ${tableName} - requires migrations`);
            } else {
              console.warn(`⚠️  Skipping ${tableName} - not in independent tables list`);
            }
          } else {
            if (!IS_PRODUCTION) {
              console.log(`📊 Table exists: ${tableName} (skipping sync)`);
            }
          }
        } catch (error) {
          console.warn(`⚠️  Could not check/process table ${tableName}:`, error.message);
        }
      }
    }
    
    // Step 3: Final sync with SAFE options - NO force, NO alter in production
    const syncOptions = {
      alter: false, // Never alter in production
      force: false, // NEVER drop tables!
      logging: false,
      hooks: true
    };
    
    if (!IS_PRODUCTION) {
      console.log(`📊 Final sync with safe options: alter=${syncOptions.alter}, force=${syncOptions.force}`);
    }
    
    // Only sync independent tables
    const independentModels = Object.entries(models).filter(([modelName, model]) => {
      const tableName = model.tableName || modelName;
      return independentTables.includes(tableName);
    });
    
    for (const [modelName, model] of independentModels) {
      try {
        await model.sync(syncOptions);
      } catch (error) {
        console.warn(`⚠️  Could not sync ${modelName}:`, error.message);
      }
    }
    
    tablesSynchronized = true;
    
    // ========== SINGLE TABLE STATUS SUMMARY ==========
    if (!IS_PRODUCTION) {
      console.log('\n📋 Database Table Status Summary:');
      console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
      
      try {
        const queryInterface = sequelize.getQueryInterface();
        const allTables = await queryInterface.showAllTables();
        
        // Count records for each table
        const tableSummary = [];
        
        for (const tableName of allTables) {
          try {
            // Find corresponding model
            const model = Object.values(models).find(m => 
              (m.tableName && m.tableName.toLowerCase() === tableName.toLowerCase()) ||
              m.name.toLowerCase() === tableName.toLowerCase()
            );
            
            if (model) {
              const count = await model.count();
              tableSummary.push({ table: tableName, records: count });
            } else {
              tableSummary.push({ table: tableName, records: 'N/A' });
            }
          } catch (countError) {
            tableSummary.push({ table: tableName, records: 'Error' });
          }
        }
        
        // Log single summary
        tableSummary.forEach((item, index) => {
          const tableNum = (index + 1).toString().padStart(2, ' ');
          const tableName = item.table.padEnd(25, ' ');
          const records = typeof item.records === 'number' ? item.records.toString().padStart(6, ' ') : item.records.padStart(6, ' ');
          console.log(`  ${tableNum}. ${tableName} | ${records} records`);
        });
        
        console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
        console.log(`  Total: ${allTables.length} tables | Production Mode: ${IS_PRODUCTION}`);
        console.log(`  Auto-create: Independent tables only | Migrations: ${migrationsRun ? 'Applied' : 'Skipped/Failed'}`);
        
      } catch (error) {
        console.log('  Could not generate table summary:', error.message);
      }
    }
    
    // ========== SINGLE STORAGE STATS LOG ==========
    if (!storageStatsLogged) {
      try {
        // Count records only for essential tables
        let dbUsers = 0;
        
        if (models.User || models.Users) {
          try {
            const userModel = models.User || models.Users;
            dbUsers = await userModel.count();
          } catch (e) {
            console.warn('Could not count users:', e.message);
          }
        }
        
        if (!IS_PRODUCTION) {
          console.log(`\n📊 Storage: Database users: ${dbUsers} | Memory users: ${users.length}`);
          console.log(`   Mode: ${dbConnected ? 'PostgreSQL (Persistent)' : 'Memory (Temporary)'}`);
        }
        storageStatsLogged = true;
      } catch (error) {
        if (!IS_PRODUCTION) {
          console.log(`\n📊 Storage: Using memory fallback`);
        }
        storageStatsLogged = true;
      }
    }
    
    databaseInitialized = true;
    return true;
    
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
    
    // Initialize empty models
    app.locals.models = {};
    
    // Log single storage stats message
    if (!storageStatsLogged && !IS_PRODUCTION) {
      console.log(`\n📊 Storage: Memory fallback active | Users: ${users.length}, Messages: ${messages.length}`);
      storageStatsLogged = true;
    }
    
    databaseInitialized = true;
    tablesSynchronized = false;
    
    // Only exit in production if DB is required
    if (IS_PRODUCTION && process.env.DB_REQUIRED === 'true') {
      console.error('💀 CRITICAL: Cannot start without database in production');
      process.exit(1);
    }
    
    return false;
  }
}

// ========== MIDDLEWARE ==========
app.use(helmet({
  contentSecurityPolicy: false,
  crossOriginEmbedderPolicy: false,
  crossOriginResourcePolicy: { policy: "cross-origin" }
}));

app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// CORS Configuration
if (!IS_PRODUCTION) {
  app.use(cors({
    origin: '*',
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS', 'PATCH', 'HEAD'],
    allowedHeaders: ['Content-Type', 'Authorization', 'Accept', 'Origin', 'X-Requested-With', 'X-Device-ID', 'X-Request-ID'],
    exposedHeaders: ['Authorization'],
    optionsSuccessStatus: 200,
    maxAge: 86400
  }));
} else {
  const allowedOrigins = [
    'http://localhost:3000',
    'http://localhost:5500',
    'http://127.0.0.1:5500',
    'http://localhost:5000',
    'http://localhost:8080',
    'http://localhost:4000',
    'https://moodfronted.com',
    FRONTEND_URL
  ].filter(Boolean);
  
  app.use(cors({
    origin: function(origin, callback) {
      if (!origin || allowedOrigins.includes(origin)) {
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
  }));
}

// Request logger
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

// Static files - ONLY in development
if (!IS_PRODUCTION) {
  app.use('/uploads', express.static(path.join(__dirname, 'uploads')));
  app.use('/assets', express.static(path.join(__dirname, 'public/assets')));
  app.use(express.static(path.join(__dirname, 'public')));
}

// ========== ROUTE MOUNTING ==========
function mountRoutes() {
  const routesPath = path.join(__dirname, 'routes');
  
  if (fs.existsSync(routesPath)) {
    if (!IS_PRODUCTION) {
      console.log(`📁 Routes directory found at: ${routesPath}`);
    }
    
    const routeFiles = fs.readdirSync(routesPath).filter(file => file.endsWith('.js'));
    
    if (routeFiles.length === 0 && !IS_PRODUCTION) {
      console.warn('⚠️  No route files found in routes directory');
    } else {
      if (!IS_PRODUCTION) {
        console.log(`📋 Found ${routeFiles.length} route file(s):`, routeFiles);
      }
      
      // Special handling for auth.js to mount at both /api and /api/auth
      const authFile = routeFiles.find(file => file === 'auth.js');
      if (authFile) {
        try {
          const authPath = path.join(routesPath, authFile);
          delete require.cache[require.resolve(authPath)];
          const authRouter = require(authPath);
          
          if (authRouter && typeof authRouter.use === 'function') {
            // Mount auth router at both /api and /api/auth
            app.use('/api', authRouter);
            app.use('/api/auth', authRouter);
            mountedRoutes.push('/api/auth/*');
            mountedRoutes.push('/api/login');
            mountedRoutes.push('/api/register');
            if (!IS_PRODUCTION) {
              console.log(`✅ Mounted auth.js at both /api and /api/auth`);
            }
          }
          
          // Remove auth.js from routeFiles to avoid duplicate mounting
          routeFiles.splice(routeFiles.indexOf(authFile), 1);
        } catch (error) {
          console.error(`❌ Failed to mount auth.js:`, error.message);
        }
      }
      
      // Mount all other routes normally
      routeFiles.forEach(file => {
        try {
          const routeName = file.replace('.js', '');
          const routePath = path.join(routesPath, file);
          
          delete require.cache[require.resolve(routePath)];
          const routeModule = require(routePath);
          
          let basePath = `/api/${routeName}`;
          if (file === 'index.js') {
            basePath = '/api';
          }
          
          if (file === 'auth.js' && routeModule && typeof routeModule === 'object' && typeof routeModule.use === 'function') {
            app.use(basePath, routeModule);
            mountedRoutes.push(`${basePath}/*`);
            if (!IS_PRODUCTION) {
              console.log(`✅ Mounted ${file} at ${basePath}`);
            }
            return;
          }
          
          if (routeModule && typeof routeModule === 'function') {
            try {
              const router = routeModule(app);
              if (router && typeof router === 'function') {
                app.use(basePath, router);
                mountedRoutes.push(`${basePath}/*`);
                if (!IS_PRODUCTION) {
                  console.log(`✅ Mounted ${file} at ${basePath}`);
                }
              } else {
                app.use(basePath, routeModule);
                mountedRoutes.push(`${basePath}/*`);
                if (!IS_PRODUCTION) {
                  console.log(`✅ Mounted ${file} at ${basePath}`);
                }
              }
            } catch (error) {
              app.use(basePath, routeModule);
              mountedRoutes.push(`${basePath}/*`);
              if (!IS_PRODUCTION) {
                console.log(`✅ Mounted ${file} at ${basePath}`);
              }
            }
          } else if (routeModule && typeof routeModule === 'object') {
            if (typeof routeModule.use === 'function') {
              app.use(basePath, routeModule);
              mountedRoutes.push(`${basePath}/*`);
              if (!IS_PRODUCTION) {
                console.log(`✅ Mounted ${file} at ${basePath}`);
              }
            } else if (routeModule.default && typeof routeModule.default === 'function') {
              const router = routeModule.default();
              app.use(basePath, router);
              mountedRoutes.push(`${basePath}/*`);
              if (!IS_PRODUCTION) {
                console.log(`✅ Mounted ${file} at ${basePath}`);
              }
            }
          }
        } catch (error) {
          console.error(`❌ Failed to mount route ${file}:`, error.message);
        }
      });
    }
  } else if (!IS_PRODUCTION) {
    console.warn(`⚠️  Routes directory not found at: ${routesPath}`);
  }
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
    database: dbConnected ? 'connected' : 'disconnected',
    tablesSynchronized: tablesSynchronized,
    tablesAutoCreated: 'Independent tables only',
    databaseProvider: process.env.DATABASE_URL ? 'Render PostgreSQL' : 'Local PostgreSQL',
    tableManagement: 'Safe: No table dropping or alteration',
    renderCompatibility: 'Optimized for Render PostgreSQL'
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
    tablesSynchronized: tablesSynchronized,
    service: 'moodchat-backend',
    version: '1.0.0',
    tableManagement: 'Safe: Independent tables auto-created only',
    migrations: 'Required for FK-dependent tables'
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
    tablesSynchronized: tablesSynchronized,
    origin: req.headers.origin || 'not specified',
    mountedRoutes: mountedRoutes.length > 0 ? mountedRoutes : 'No routes mounted from routes directory',
    tableManagement: 'Safe: No table dropping',
    renderCompatibility: 'Optimized for Render PostgreSQL',
    renderMode: IS_RENDER ? 'Running on Render' : 'Not on Render'
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
      tablesSynchronized: tablesSynchronized,
      databaseInitialized: databaseInitialized,
      env: {
        NODE_ENV: NODE_ENV,
        DATABASE_URL: process.env.DATABASE_URL ? 'Set' : 'Not set',
        DB_HOST: process.env.DB_HOST,
        RENDER: process.env.RENDER ? 'Yes' : 'No'
      },
      tablePolicy: 'Independent tables auto-created only',
      modelsLoaded: Object.keys(models).length,
      loadedModels: Object.keys(models)
    });
  } else {
    res.status(404).json({
      success: false,
      message: 'Debug endpoint not available in production',
      timestamp: new Date().toISOString()
    });
  }
});

// ========== AUTH ROUTES ==========
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
      // Find the correct User model (could be User or Users)
      const UserModel = models.User || models.Users;
      if (!UserModel) {
        return res.status(500).json({
          success: false,
          message: 'User model not available',
          timestamp: new Date().toISOString()
        });
      }
      
      const existingUser = await UserModel.findOne({ where: { email } });
      if (existingUser) {
        return res.status(400).json({
          success: false,
          message: 'User already exists',
          timestamp: new Date().toISOString()
        });
      }
      
      const hashedPassword = await bcrypt.hash(password, 10);
      
      const user = await UserModel.create({
        email,
        username,
        password: hashedPassword,
        avatar: `https://ui-avatars.com/api/?name=${encodeURIComponent(username)}&background=random&color=fff`
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
        storage: 'PostgreSQL (Permanent)'
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
      // Find the correct User model
      const UserModel = models.User || models.Users;
      if (!UserModel) {
        return res.status(500).json({
          success: false,
          message: 'User model not available',
          timestamp: new Date().toISOString()
        });
      }
      
      let user;
      if (email.includes('@')) {
        user = await UserModel.findOne({ where: { email } });
      } else {
        user = await UserModel.findOne({ where: { username: email } });
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
        storage: 'PostgreSQL'
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
      // Find the correct User model
      const UserModel = models.User || models.Users;
      if (!UserModel) {
        return res.status(500).json({
          success: false,
          message: 'User model not available',
          timestamp: new Date().toISOString()
        });
      }
      
      const user = await UserModel.findByPk(req.user.userId);
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
        storage: 'PostgreSQL'
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
      storage: 'memory'
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
      storage: 'memory'
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
    
    // Also save to database if available
    if (dbConnected && tablesSynchronized && (models.Message || models.Messages)) {
      try {
        const MessageModel = models.Message || models.Messages;
        MessageModel.create({
          room,
          content,
          sender_id: user.id,
          sender_username: user.username,
          sender_avatar: user.avatar
        }).catch(dbError => {
          console.error('Failed to save message to database:', dbError.message);
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
      storage: dbConnected ? 'memory+database' : 'memory'
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
      tablesSynchronized: tablesSynchronized,
      tablePolicy: 'Independent tables auto-created only'
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
      tablesSynchronized: tablesSynchronized
    }
  });
});

// ========== API CATCH-ALL ==========
app.all('/api/*', (req, res) => {
  if (!IS_PRODUCTION) {
    console.warn(`⚠️  Unhandled API route: ${req.method} ${req.path}`);
  }
  res.status(404).json({
    success: false,
    message: `API endpoint ${req.method} ${req.path} not found`,
    timestamp: new Date().toISOString(),
    availableEndpoints: [
      '/api/health',
      '/api/status',
      '/api/debug',
      '/api/register',
      '/api/login',
      '/api/auth/me',
      '/api/chat/rooms',
      '/api/chat/messages/:room',
      '/api/chat/messages',
      '/api/stats',
      '/api/test-json'
    ],
    database: {
      connected: dbConnected,
      tablesSynchronized: tablesSynchronized,
      tablePolicy: 'Independent tables auto-created only'
    }
  });
});

// ========== STATIC PAGES ==========
if (!IS_PRODUCTION) {
  app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
  });

  app.get('/login', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html.html'));
  });

  app.get('/register', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html.html'));
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
      documentation: 'API endpoints available at /api/*'
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
      tablesSynchronized: tablesSynchronized
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
      tablesSynchronized: tablesSynchronized,
      tablePolicy: 'Independent tables auto-created only'
    }
  });
});

// ========== START SERVER ==========
const startServer = async () => {
  console.log('🚀 Starting MoodChat Backend Server...');
  console.log(`📁 Environment: ${NODE_ENV}`);
  console.log(`🌐 Port: ${PORT}`);
  console.log(`🗄️  Database: Safe table management enabled`);
  console.log(`🔧 Render Mode: ${IS_RENDER ? 'Yes' : 'No'}`);
  console.log(`🔨 Automatic Table Creation: INDEPENDENT TABLES ONLY`);
  console.log(`📈 Render PostgreSQL Compatibility: SAFE MODE`);
  
  // Initialize database with safe table management
  console.log('🔄 Initializing database with safe table management...');
  console.log('📊 Independent tables auto-created, dependent tables require migrations...');
  await initializeDatabase();
  
  // Mount routes
  console.log('📡 Mounting routes...');
  mountRoutes();
  
  // Final verification
  if (tablesSynchronized) {
    console.log('✅ Database tables ready for production.');
    console.log('✅ Safe table management: No table dropping or alteration.');
    console.log('✅ Render PostgreSQL compatibility: SAFE MODE');
  } else {
    console.warn('⚠️  Tables not synchronized, using in-memory storage');
    console.log('ℹ️  In-memory storage active for users, messages, and chat rooms');
  }
  
  const server = app.listen(PORT, '0.0.0.0', () => {
    console.log(`┌──────────────────────────────────────────────────────────┐`);
    console.log(`│                                                          │`);
    console.log(`│   🚀 MoodChat Backend Server Started                     │`);
    console.log(`│                                                          │`);
    console.log(`│   📍 Local:    http://localhost:${PORT}                  ${PORT < 1000 ? ' ' : ''}`);
    console.log(`│   🌐 Env:      ${NODE_ENV}                               `);
    console.log(`│   ⏱️  Time:     ${new Date().toLocaleString()}           `);
    console.log(`│   🗄️  Database: ${dbConnected ? '✅ Connected' : '⚠️  Not Connected'}    `);
    console.log(`│   📊 Tables:   ${tablesSynchronized ? '✅ Safe Mode' : '⚠️  Not Synced'}    `);
    console.log(`│   🔓 CORS:     ${!IS_PRODUCTION ? 'ALLOW ALL' : 'RESTRICTED'}    `);
    console.log(`│   🛣️  Routes:   ${mountedRoutes.length} mounted           `);
    console.log(`│   🔧 Auto Tables: INDEPENDENT ONLY                       `);
    console.log(`│   📈 Render PG: ${tablesSynchronized ? '✅ SAFE MODE' : '⚠️  CHECK CONFIG'}  `);
    console.log(`│   🗂️  Models:    ${Object.keys(models).length} loaded      `);
    console.log(`│                                                          │`);
    console.log(`│   📊 Health:   http://localhost:${PORT}/api/health       ${PORT < 1000 ? ' ' : ''}`);
    console.log(`│   🔐 Status:   http://localhost:${PORT}/api/status       ${PORT < 1000 ? ' ' : ''}`);
    if (!IS_PRODUCTION) {
      console.log(`│   🐛 Debug:    http://localhost:${PORT}/api/debug        ${PORT < 1000 ? ' ' : ''}`);
    }
    console.log(`│   💬 API Base: http://localhost:${PORT}/api              ${PORT < 1000 ? ' ' : ''}`);
    console.log(`│                                                          │`);
    
    if (!IS_PRODUCTION) {
      console.log(`│   📄 Pages:                                               │`);
      console.log(`│   • Home:      http://localhost:${PORT}/                 ${PORT < 1000 ? ' ' : ''}`);
      console.log(`│   • Login:     http://localhost:${PORT}/login            ${PORT < 1000 ? ' ' : ''}`);
      console.log(`│   • Register:  http://localhost:${PORT}/register         ${PORT < 1000 ? ' ' : ''}`);
      console.log(`│   • Chat:      http://localhost:${PORT}/chat             ${PORT < 1000 ? ' ' : ''}`);
      console.log(`│                                                          │`);
    }
    
    console.log(`│   PostgreSQL: Independent tables auto-created only        │`);
    console.log(`│   Press Ctrl+C to stop                                   │`);
    console.log(`│                                                          │`);
    console.log(`└──────────────────────────────────────────────────────────┘`);
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

// Start server
if (require.main === module) {
  startServer().catch(error => {
    console.error('❌ Failed to start server:', error);
    process.exit(1);
  });
}

module.exports = { app, sequelize, startServer, tablesSynchronized };